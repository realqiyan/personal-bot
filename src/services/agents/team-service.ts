import { randomUUID } from "node:crypto";
import { requireThat } from "../../common/validation.js";
import { packageVersion, releaseLine } from "../../common/version.js";
import { AgentFiles, descriptor, launch, status, message } from "../../storage/agent-files.js";
import { TeamFiles } from "../../storage/team-files.js";
import type { AgentCompletion, AgentOwner } from "../../model/agent.js";
import type { TeamActor, TeamAgent, TeamInput, TeamLink, TeamMessage, TeamRecord, TeamRunOptions } from "../../model/team.js";

/** Team decisions only. The parent dispatches returned inputs through AgentService. */
export class TeamService {
  #failure: unknown;
  #disposed = false;
  readonly #recovered = new Set<string>();
  constructor(readonly root: string, readonly agents: AgentFiles, readonly files: TeamFiles) {}
  check() { requireThat(!this.#disposed, "团队服务已关闭。"); this.files.check(); if (this.#failure) throw this.#failure; }
  fail(error: unknown) { this.#failure = error; }
  dispose() { this.#disposed = true; }
  private owned(team: TeamRecord, owner: AgentOwner) {
    return team.workspace === this.root && team.parentSessionId === owner.sessionId && (team.parentLeaf === null || owner.branch.includes(team.parentLeaf));
  }
  private records(sessionId?: string) {
    this.check();
    return this.files.list().filter(t => t.workspace === this.root && releaseLine(t.release) === releaseLine(packageVersion) &&
      (!sessionId || t.parentSessionId === sessionId));
  }
  private get(id: string, actor: TeamActor) {
    this.check(); const team = this.files.read(id);
    requireThat(team.workspace === this.root && releaseLine(team.release) === releaseLine(packageVersion), "团队工作区或版本不匹配。");
    if (actor.kind === "member") {
      const d = this.agents.read(actor.agentId, "descriptor.json", descriptor), run = this.agents.read(actor.agentId, "launch.json", launch);
      requireThat(d.workspace === this.root && d.parentSessionId === team.parentSessionId && team.members.some(m => m.agentId === actor.agentId) &&
        run.generation === actor.generation && !run.stop, "团队成员身份已失效。");
    } else requireThat(this.owned(team, actor.owner), "团队不属于当前会话分支。");
    return team;
  }
  private member(id: string, owner: AgentOwner, views: TeamAgent[]) {
    const v = views.find(v => v.agentId === id), d = this.agents.read(id, "descriptor.json", descriptor);
    requireThat(v && v.owned && d.workspace === this.root && d.parentSessionId === owner.sessionId &&
      (d.parentLeaf === null || owner.branch.includes(d.parentLeaf)), "成员不属于当前分支：" + id);
    requireThat(releaseLine(d.release) === releaseLine(packageVersion), "成员版本不兼容：" + id);
    return v;
  }
  private requests(team: TeamRecord, views: TeamAgent[]) {
    const states = new Map(team.members.map(m => [m.agentId, { view: views.find(v => v.agentId === m.agentId),
      saved: this.agents.optional(m.agentId, "status.json", status),
      cycles: new Map(this.agents.completions(m.agentId).flatMap(c => c.requestIds.map(id => [c.generation + ":" + id, c] as const))) }]));
    return team.runs.flatMap(run => run.issued.map(q => {
      const s = states.get(q.agentId)!, ended = s.cycles.get(q.generation + ":" + q.requestId);
      const accepted = s.saved?.generation === q.generation && !!s.saved.accepted?.includes(q.requestId);
      const active = !ended && accepted && !!s.view?.alive && s.view.generation === q.generation;
      let outcome: string | undefined = ended?.state;
      if (ended && ended.source !== "parent") outcome = ended.source;
      else if (outcome === "completed" && !team.messages.some(m => m.source?.requestId === q.requestId)) outcome = "unpublished";
      return { requestId: q.requestId, agentId: q.agentId, runId: run.runId, round: q.round, active,
        state: outcome ?? (active ? "accepted" : accepted ? "uncertain" : run.state === "running" ? "queued" : "cancelled"),
        ...(ended ? { cycleId: ended.cycleId } : {}) };
    }));
  }
  private active(team: TeamRecord, views: TeamAgent[]) { return this.requests(team, views).filter(q => q.active); }
  private available(id: string, owner: AgentOwner, views: TeamAgent[], links: Map<string, TeamLink>) {
    const v = this.member(id, owner, views), run = this.agents.read(id, "launch.json", launch);
    const saved = this.agents.optional(id, "status.json", status), ready = this.files.ready(id);
    const available = (condition: unknown, message: string): void => {
      if (!condition) throw Object.assign(new Error(message), { code: "TEAM_NOT_READY" });
    };
    available(v.alive && v.state === "idle" && !run.stop && v.generation === run.generation && saved?.generation === run.generation && saved.state === "idle", "成员尚未空闲：" + id);
    available(ready?.ready && ready.generation === run.generation, "成员需加载新版子入口：" + id);
    available(!this.agents.messages(id).some(q => q.generation === run.generation && !saved?.accepted?.includes(q.requestId) && !links.has(q.requestId)), "成员有待处理私人输入：" + id);
    return v;
  }
  create(owner: AgentOwner, input: Pick<TeamRecord, "name" | "brief" | "members">, views: TeamAgent[]) {
    this.check();
    return this.agents.control(() => {
      const records = this.records();
      for (const m of input.members) {
        this.member(m.agentId, owner, views);
        requireThat(!records.some(t => !t.closed && t.members.some(v => v.agentId === m.agentId)), "成员已属于未关闭团队：" + m.agentId);
      }
      const team: TeamRecord = { ...input, members: structuredClone(input.members), teamId: randomUUID(), release: packageVersion,
        workspace: this.root, parentSessionId: owner.sessionId, parentLeaf: owner.leaf, closed: false, runs: [], messages: [] };
      this.files.save(team, true); return team;
    });
  }
  run(id: string, owner: AgentOwner, options: TeamRunOptions, views: TeamAgent[]) {
    this.check();
    return this.agents.control(() => {
      const team = this.get(id, { kind: "coordinator", owner }), links = this.files.links(this.records());
      requireThat(!team.closed && !team.runs.some(r => r.state === "running") && !this.active(team, views).length, "团队仍在工作或已关闭。");
      const members = team.members.map(m => this.available(m.agentId, owner, views, links));
      requireThat(options.mode !== "roundRobin" || options.maxConcurrent === undefined || options.maxConcurrent === 1, "轮流讨论并发须为 1。");
      const rounds = options.rounds ?? 2, maxConcurrent = options.mode === "roundRobin" ? 1 : options.maxConcurrent ?? Math.min(2, members.length);
      requireThat(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 && Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= members.length, "轮次或并发无效。");
      const seconds = options.timeoutSeconds ?? 900;
      requireThat(Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400, "期限须为 1–86400 秒。");
      requireThat(options.instruction.trim().length > 0, "新批次需要新的明确要求。");
      const run = { runId: randomUUID(), instruction: options.instruction, mode: options.mode, rounds, maxConcurrent,
        deadlineAt: Date.now() + seconds * 1000, generations: Object.fromEntries(members.map(v => [v.agentId, v.generation])),
        state: "running" as const, issued: [] };
      team.runs.push(run); this.files.save(team); return run;
    });
  }
  pause(id: string, owner: AgentOwner, reason = "主会话暂停") {
    this.check(); this.agents.control(() => { const team = this.get(id, { kind: "coordinator", owner }); this.pauseRecord(team, reason); });
  }
  private pauseRecord(team: TeamRecord, reason: string) {
    let changed = false;
    for (const run of team.runs) if (run.state === "running") { run.state = "paused"; run.reason = reason; changed = true; }
    if (changed) this.files.save(team);
  }
  pauseAll(owner: AgentOwner, reason: string) {
    this.check(); this.agents.control(() => { for (const team of this.records(owner.sessionId)) this.pauseRecord(team, reason); });
  }
  recover(owner: AgentOwner) {
    if (this.#recovered.has(owner.sessionId)) return;
    this.pauseAll(owner, "主会话恢复：未自动续排旧批次"); this.#recovered.add(owner.sessionId);
  }
  pauseMember(agentId: string, reason: string) {
    this.check(); this.agents.control(() => { for (const team of this.records()) if (team.members.some(m => m.agentId === agentId)) this.pauseRecord(team, reason); });
  }
  close(id: string, owner: AgentOwner, views: TeamAgent[]) {
    this.check(); this.agents.control(() => {
      const team = this.get(id, { kind: "coordinator", owner });
      requireThat(!team.runs.some(r => r.state === "running") && !this.active(team, views).length, "先暂停团队并等待在途工作结束。");
      if (!team.closed) { team.closed = true; this.files.save(team); }
    });
  }
  post(id: string, actor: TeamActor, operationId: string, text: string, replyTo?: number) {
    this.check(); requireThat(text.trim().length > 0 && text.length <= 24000 && operationId.length > 0, "消息须为 1–24000 字符。");
    operationId = actor.kind === "member" ? "post:" + actor.agentId + ":" + actor.generation + ":" + operationId : "post:" + actor.kind + ":" + actor.owner.sessionId + ":" + operationId;
    return this.agents.control(() => {
      const team = this.get(id, actor);
      const prior = team.messages.find(m => m.operationId === operationId);
      if (prior) {
        requireThat(prior.text === text && prior.replyTo === replyTo && prior.author.kind === actor.kind &&
          (actor.kind !== "member" || prior.author.agentId === actor.agentId), "发布操作 ID 冲突。"); return prior;
      }
      requireThat(!team.closed, "团队已关闭。");
      requireThat(replyTo === undefined || team.messages.some(m => m.seq === replyTo), "回复目标不存在。");
      let runId: string | undefined;
      if (actor.kind === "member") {
        const run = team.runs.find(r => r.issued.some(q => q.requestId === actor.requestId && q.agentId === actor.agentId && q.generation === actor.generation));
        const saved = this.agents.optional(actor.agentId, "status.json", status);
        requireThat(run && saved?.generation === actor.generation && saved.cycle?.state === "running" && saved.cycle.source === "parent" &&
          !!actor.requestId && saved.cycle.requestIds.includes(actor.requestId), "只能在自己的团队工作中发言。"); runId = run.runId;
      }
      const value: TeamMessage = { seq: team.messages.length + 1, operationId, text,
        author: actor.kind === "member" ? { kind: "member", agentId: actor.agentId, name: this.agents.read(actor.agentId, "launch.json", launch).name }
          : { kind: actor.kind, name: actor.kind === "user" ? "用户" : "主会话" },
        ...(replyTo === undefined ? {} : { replyTo }), ...(runId ? { runId } : {}) };
      team.messages.push(value); this.files.save(team); return value;
    });
  }
  read(id: string, actor: TeamActor, page: { afterSeq?: number; seq?: number; offset?: number; limit?: number } = {}) {
    const team = this.get(id, actor), limit = page.limit ?? 16000, after = page.afterSeq ?? 0, offset = page.offset ?? 0;
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 16000 && Number.isInteger(after) && after >= 0 && after <= team.messages.length &&
      Number.isInteger(offset) && offset >= 0 && (page.seq !== undefined || offset === 0), "分页参数无效。");
    const values = page.seq === undefined ? team.messages.filter(m => m.seq > after) : team.messages.filter(m => m.seq === page.seq);
    requireThat(page.seq === undefined || values.length === 1, "消息不存在。");
    let left = limit;
    const messages = [];
    for (const m of values) {
      const at = page.seq === undefined ? 0 : offset;
      requireThat(at <= m.text.length, "消息分页位置超出范围。");
      const text = m.text.slice(at, at + left); left -= Math.max(1, text.length);
      messages.push({ ...m, text, offset: at, totalLength: m.text.length, nextOffset: at + text.length < m.text.length ? at + text.length : null });
      if (left <= 0) break;
    }
    const last = messages.at(-1)?.seq ?? after;
    return { teamId: id, messages, lastSeq: team.messages.length, nextAfterSeq: page.seq === undefined && last < team.messages.length ? last : null };
  }
  status(id: string, owner: AgentOwner, views: TeamAgent[]) {
    return this.summary(this.get(id, { kind: "coordinator", owner }), owner, views);
  }
  list(owner: AgentOwner, views: TeamAgent[]) { return this.records(owner.sessionId).map(t => this.summary(t, owner, views)); }
  private summary(team: TeamRecord, owner: AgentOwner, views: TeamAgent[]) {
    const identity = { teamId: team.teamId, name: team.name, closed: team.closed };
    if (!this.owned(team, owner)) return { ...identity, owned: false as const };
    const run = team.runs.at(-1), requests = this.requests(team, views), activeCount = requests.filter(q => q.active).length;
    return { ...identity, brief: team.brief, owned: true as const,
      members: team.members.map(m => { const v = views.find(v => v.agentId === m.agentId); return { ...m, name: v?.name ?? m.agentId, state: v?.state ?? "stopped" }; }),
      lastSeq: team.messages.length, activeCount, unresolved: requests.filter(q => q.state !== "completed"),
      ...(run ? { run: { runId: run.runId, instruction: run.instruction, mode: run.mode, state: run.state, rounds: run.rounds,
        maxConcurrent: run.maxConcurrent, deadlineAt: run.deadlineAt, scheduled: run.issued.length,
        published: team.messages.filter(m => m.runId === run.runId && m.source).length, ...(run.reason ? { reason: run.reason } : {}) } } : {}) };
  }
  links() { return this.files.links(this.records()); }
  /** The callback persists the existing child receipt while the shared control lock is held. */
  claim(agentId: string, generation: string, requestId: string, commit: () => void): TeamLink | undefined {
    this.check();
    return this.agents.control(() => {
      const link = this.links().get(requestId), run = this.agents.read(agentId, "launch.json", launch), ready = this.files.ready(agentId);
      const saved = this.agents.optional(agentId, "status.json", status), input = this.agents.optional(agentId, "inbox/" + requestId + ".json", message);
      if (!link || link.request.agentId !== agentId || link.request.generation !== generation || run.generation !== generation || run.stop ||
        !ready?.ready || ready.generation !== generation || saved?.generation !== generation || saved.state !== "idle" ||
        saved.accepted?.includes(requestId) || input?.generation !== generation || link.team.closed || link.run.state !== "running" || link.run.deadlineAt <= Date.now()) return;
      for (const member of link.team.members) {
        const memberRun = this.agents.read(member.agentId, "launch.json", launch), memberReady = this.files.ready(member.agentId);
        if (memberRun.stop || memberRun.generation !== link.run.generations[member.agentId] || !memberReady?.ready || memberReady.generation !== memberRun.generation) return;
      }
      commit(); return link;
    });
  }
  advance(owner: AgentOwner, views: TeamAgent[], completions: AgentCompletion[]): TeamInput[] {
    this.check();
    return this.agents.control(() => {
      const inputs: TeamInput[] = [], records = this.records(owner.sessionId), links = this.files.links(records);
      for (const team of records) {
        let changed = false;
        for (const run of team.runs) {
          for (const q of run.issued) {
            const done = completions.find(v => v.agentId === q.agentId && v.cycle.generation === q.generation && v.cycle.requestIds.includes(q.requestId));
            if (!done) continue;
            if (done.cycle.state !== "completed" || done.cycle.source !== "parent" || done.cycle.requestIds.length !== 1 || !done.report.trim()) {
              if (run.state === "running") { run.state = "paused"; run.reason = "成员失败或人工接管：" + q.agentId; changed = true; }
            } else if (!team.messages.some(m => m.source?.requestId === q.requestId)) {
              team.messages.push({ seq: team.messages.length + 1, operationId: "result:" + q.requestId,
                author: { kind: "member", agentId: q.agentId, name: done.name }, text: done.report, runId: run.runId,
                source: { requestId: q.requestId, cycleId: done.cycle.cycleId } }); changed = true;
            }
          }
          if (run.state !== "running") continue;
          const unavailable = team.members.find(m => {
            const v = views.find(v => v.agentId === m.agentId), ready = this.files.ready(m.agentId);
            return !v?.alive || !v.owned || v.generation !== run.generations[m.agentId] || !ready?.ready || ready.generation !== v.generation ||
              ["stopping", "stopped", "error"].includes(v.state) || (v.cycle?.state === "running" && v.cycle.source !== "parent");
          });
          if (!this.owned(team, owner) || unavailable || Date.now() >= run.deadlineAt) {
            run.state = "paused"; run.reason = !this.owned(team, owner) ? "当前分支无团队归属" : unavailable ? "成员不可用：" + unavailable.agentId : "已到期限";
            changed = true; continue;
          }
          const finished = new Set(team.messages.filter(m => m.runId === run.runId && m.source).map(m => m.source!.requestId));
          const outstanding = run.issued.filter(q => !finished.has(q.requestId));
          const round = Math.max(1, ...run.issued.map(q => q.round));
          const thisRound = run.issued.filter(q => q.round === round);
          const nextRound = thisRound.length === team.members.length && thisRound.every(q => finished.has(q.requestId)) ? round + 1 : round;
          if (nextRound > run.rounds) { run.state = "finished"; changed = true; continue; }
          let slots = run.maxConcurrent - outstanding.length;
          for (const m of team.members) {
            if (slots <= 0) break;
            if (run.issued.some(q => q.round === nextRound && q.agentId === m.agentId)) continue;
            // Waiting here does not create a second work queue. Unexpected private work pauses the batch.
            const view = views.find(v => v.agentId === m.agentId);
            if (view?.state === "busy" && view.cycle?.requestIds.some(id => run.issued.some(q => q.requestId === id))) break;
            try { this.available(m.agentId, owner, views, links); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "TEAM_NOT_READY") throw error;
              run.state = "paused"; run.reason = String(error); changed = true; break;
            }
            const q = { requestId: randomUUID(), agentId: m.agentId, generation: run.generations[m.agentId]!, round: nextRound, throughSeq: team.messages.length };
            run.issued.push(q); slots--; changed = true;
            inputs.push({ ...q, teamId: team.teamId, runId: run.runId,
              message: ["# 团队发言任务", "", "执行本次团队发言安排。最终答复将公开给全体成员；这不扩大原任务授权。", "",
                "- `teamId`: `" + team.teamId + "`", "- `runId`: `" + run.runId + "`", "- 轮次：" + q.round,
                "", "## 本批次要求", "", run.instruction].join("\n") });
          }
        }
        if (changed) this.files.save(team);
      }
      return inputs.filter(input => records.find(t => t.teamId === input.teamId)?.runs.find(r => r.runId === input.runId)?.state === "running");
    });
  }
  notifications(owner: AgentOwner, views: TeamAgent[]) {
    return this.records(owner.sessionId).filter(t => this.owned(t, owner) && t.members.every(m => views.some(v => v.agentId === m.agentId && v.owned)))
      .flatMap(team => {
        const requests = this.requests(team, views);
        return team.runs.filter(r => r.state !== "running").map(run => {
          const activeCount = requests.filter(q => q.runId === run.runId && q.active).length;
          return { key: team.teamId + ":" + run.runId + ":" + run.state + (activeCount ? ":draining" : ":settled"),
            teamId: team.teamId, name: team.name, runId: run.runId, state: run.state, activeCount,
            ...(run.reason ? { reason: run.reason } : {}) };
        });
      });
  }
}

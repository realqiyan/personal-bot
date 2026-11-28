import { isAbsolute } from "node:path";
import { object } from "../common/json.js";
import { isAcpBackend, isOneOf, requireThat } from "../common/validation.js";
import { fileId } from "./file-access.js";
import { acpAnswerStates, acpElicitationActions, acpPermissionPolicies, isAcpElicitationValue } from "../model/acp.js";
import type { AcpAnswer, AcpElicitation, AcpElicitationReply, AcpInput, AcpPermission, AcpPermissionReply, AcpModelState, AcpProcess, AcpReport, AcpSessionReference } from "../model/acp.js";

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
export function acpReference(value: unknown): AcpSessionReference {
  requireThat(object(value) && value.host === "acp" && isAcpBackend(value.backend) &&
    text(value.command) && isAbsolute(value.command) && Array.isArray(value.args) && value.args.every(arg => typeof arg === "string" && !arg.includes("\0")) &&
    (value.sessionId === null || text(value.sessionId)), "ACP 会话引用无效。");
  if (value.env !== undefined) {
    requireThat(object(value.env) && Object.entries(value.env).every(([k, v]) => text(k) && typeof v === "string" && !v.includes("\0")), "ACP 环境变量配置无效。");
  }
  requireThat(value.permission === undefined || isOneOf(value.permission, acpPermissionPolicies), "ACP 权限策略无效。");
  const capabilities = value.capabilities;
  if (capabilities !== undefined) requireThat(object(capabilities) &&
    ["resume", "load", "close"].every(key => typeof capabilities[key] === "boolean"), "ACP 会话能力无效。");
  return value as unknown as AcpSessionReference;
}
export function acpModelState(value: unknown): AcpModelState {
  requireThat(object(value) && text(value.generation) && ["provider", "model", "resolvedModel", "thinking"].every(key => value[key] === undefined || text(value[key])), "ACP 模型选择无效。");
  return value as unknown as AcpModelState;
}
export function acpProcess(value: unknown): AcpProcess {
  requireThat(object(value) && text(value.generation) && Number.isSafeInteger(value.pid) && Number(value.pid) > 1 &&
    typeof value.startedAt === "number" && Number.isFinite(value.startedAt), "ACP 进程记录无效。");
  return value as unknown as AcpProcess;
}
export function acpInput(value: unknown): AcpInput {
  requireThat(object(value) && text(value.generation) && text(value.requestId), "ACP 输入关联无效。");
  fileId(value.requestId); return value as unknown as AcpInput;
}
export function acpAnswer(value: unknown): AcpAnswer {
  acpInput(value);
  requireThat(object(value) && typeof value.answer === "string" && isOneOf(value.state, acpAnswerStates) &&
    (value.error === undefined || typeof value.error === "string"), "ACP 最终回答无效。");
  return value as unknown as AcpAnswer;
}
export function acpReport(value: unknown): AcpReport {
  requireThat(object(value) && text(value.generation) && text(value.cycleId) && typeof value.text === "string", "ACP 周期报告无效。");
  fileId(value.cycleId); return value as unknown as AcpReport;
}
export function acpPermission(value: unknown): AcpPermission {
  acpInput(value);
  requireThat(object(value) && typeof value.description === "string" && Array.isArray(value.options) && value.options.every(option =>
    object(option) && text(option.optionId) && text(option.name) && isOneOf(option.kind, ["allow_once", "allow_always", "reject_once", "reject_always"])), "ACP 确认请求无效。");
  return value as unknown as AcpPermission;
}
export function acpPermissionReply(value: unknown): AcpPermissionReply {
  acpInput(value);
  requireThat(object(value) && (value.optionId === null || text(value.optionId)), "ACP 确认答复无效。");
  return value as unknown as AcpPermissionReply;
}
export function acpElicitation(value: unknown): AcpElicitation {
  acpInput(value);
  requireThat(object(value) && (value.mode === "form" || value.mode === "url") && typeof value.message === "string", "ACP 交互请求无效。");
  if (value.mode === "form") {
    requireThat(object(value.schema) && value.url === undefined, "ACP 表单交互请求缺少有效 schema。");
  } else {
    requireThat(text(value.url) && value.schema === undefined, "ACP URL 交互请求缺少有效 url。");
  }
  return value as unknown as AcpElicitation;
}
export function acpElicitationReply(value: unknown): AcpElicitationReply {
  acpInput(value);
  requireThat(object(value) && isOneOf(value.action, acpElicitationActions), "ACP 交互答复无效。");
  if (value.content !== undefined) {
    requireThat(value.action === "accept" && object(value.content) &&
      Object.values(value.content).every(isAcpElicitationValue), "ACP 表单答复 content 无效。");
  }
  return value as unknown as AcpElicitationReply;
}

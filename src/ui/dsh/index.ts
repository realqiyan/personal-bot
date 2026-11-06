import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import { pbotReadRemote } from "./remote.js";
import { showManagement } from "./management.js";

export const name = "personal-bot";
export const inject = ["remote"];

export async function apply(ctx: Context) {
  ctx.remote.$mount(pbotReadRemote);
  await ctx.plugin({ name: "pbot-management-view", inject: ["commandUi", "remote", "remote.commands", "remote.pbot", "fileUpload"],
    apply(view) {
      view.commandUi.decorate({ name: "pbot", available: () => true,
        ui: { kind: "action", run: session => { showManagement(view, session.sessionId); } } });
    },
  });
}

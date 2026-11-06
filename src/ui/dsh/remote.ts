import type { InvocationDescriptor, RemoteResult, TypertCodec, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import { json, type Json } from "../../common/json.js";

type Query = (request: Json, signal?: AbortSignal) => Promise<RemoteResult<Json>>;
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    pbot: { snapshot: Query; expert: Query; team: Query; history: Query };
  }
}

// Native Typert descriptors shared by the Host and browser. Domain contracts validate each request in the Host.
const value: TypertCodec<Json> = { mode: "strict", typeSymbol: "personal-bot#Json", create: () => ({ parse: json }) };
export const pbotReadRemote: TypertRemoteContribution = {
  package: "personal-bot",
  descriptors: ["snapshot", "expert", "team", "history"].map((method): InvocationDescriptor => ({
    id: "personal-bot#PbotManagement." + method, service: "pbotManagement", namespace: "pbot", method,
    invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: value }],
    cancellation: { parameter: "signal" }, result: value,
  })),
};

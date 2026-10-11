/** Public plugin RPC and saved wake-up shape; scheduling rules stay in server/. */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const pendingWakeupSchema = z.object({
  agentId: z.string().min(1),
  providerId: z.string().min(1),
  lastUserMessageAt: z.string().nullable(),
  stoppedAt: z.number().finite(),
  notBefore: z.number().finite().nullable(),
  reportedReset: z.number().finite().nullable(),
  reason: z.string(),
});

export type PendingWakeup = z.infer<typeof pendingWakeupSchema>;

export const wakeupRpc = defineRpc({
  name: "wakeup.inspect",
  input: z.object({
    agentId: z.string().min(1).optional(),
    action: z.enum(["status", "cancel"]).default("status"),
  }),
  output: z.object({ pending: z.array(pendingWakeupSchema) }),
});

/** Agent panel for the plugin's public status/cancel RPC. */
import type { ReactElement } from "react";
import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type PendingWakeup, wakeupRpc } from "../shared/wakeup.ts";

interface WakeupPanelState {
  pending: PendingWakeup | undefined;
  message: string;
  error: Error | null;
  cancelling: boolean;
  cancel: () => void;
}
type WakeupPanelTheme = PluginAgentPanelProps["theme"];
interface WakeupCancellationState {
  pending: boolean;
  error: Error | null;
  cancel: () => void;
}

/** Show a pending reset and cancellation. Example: open through /wakeup. */
export function WakeupPanel({ agentId, theme, layout }: PluginAgentPanelProps): ReactElement {
  const state = useWakeupPanelState(agentId);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 20 }}>Automatic wake-up</Text>
      <WakeupSummary state={state} theme={theme} />
      {state.pending && <WakeupCancellation state={state} theme={theme} />}
    </ScrollView>
  );
}

function useWakeupPanelState(agentId: string): WakeupPanelState {
  const inspect = useRpc(wakeupRpc);
  const queryKey = ["wakeup", agentId];
  const status = useQuery({
    queryKey,
    queryFn: () => inspect({ agentId, action: "status" }),
    refetchInterval: 10_000,
  });
  const cancellation = useWakeupCancellation(agentId);
  const pending = status.data?.pending[0];
  const emptyMessage = status.error
    ? "Wake-up status unavailable."
    : "No wake-up pending. Usage-limit stops are watched automatically while this plugin is enabled.";
  return {
    pending,
    message: status.isPending ? "Checking…" : (pending?.reason ?? emptyMessage),
    error: status.error ?? cancellation.error,
    cancelling: cancellation.pending,
    cancel: cancellation.cancel,
  };
}

function useWakeupCancellation(agentId: string): WakeupCancellationState {
  const inspect = useRpc(wakeupRpc);
  const queryClient = useQueryClient();
  const cancellation = useMutation({
    mutationFn: () => inspect({ agentId, action: "cancel" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wakeup", agentId] }),
  });
  return {
    pending: cancellation.isPending,
    error: cancellation.error,
    cancel: () => cancellation.mutate(),
  };
}

function WakeupSummary({
  state,
  theme,
}: {
  state: WakeupPanelState;
  theme: WakeupPanelTheme;
}): ReactElement {
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{state.message}</Text>
      {state.pending?.notBefore != null && (
        <Text style={{ color: theme.colors.foreground }}>
          Resume after {new Date(state.pending.notBefore).toLocaleString()}
        </Text>
      )}
      {state.error && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {state.error.message}
        </Text>
      )}
    </View>
  );
}

function WakeupCancellation({
  state,
  theme,
}: {
  state: WakeupPanelState;
  theme: WakeupPanelTheme;
}): ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel automatic wake-up"
      disabled={state.cancelling}
      onPress={state.cancel}
      style={{ padding: 12, borderRadius: 8, backgroundColor: theme.colors.accent }}
    >
      <Text style={{ color: theme.colors.accentForeground }}>
        {state.cancelling ? "Cancelling…" : "Cancel wake-up"}
      </Text>
    </Pressable>
  );
}

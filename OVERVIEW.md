Wake-up automatically continues an interrupted Paseo chat after its provider usage limit resets. It sends a short continuation into the same session, preserving the original conversation and completed work.

The plugin watches new usage-limit stops. It reads the provider's quota windows, waits for the latest exhausted window plus a one-minute buffer, and checks quota again before sending. The wait time in the provider's own message also counts: a duration such as “try again in 15 minutes”, a Claude clock time such as “resets 2:20am (Europe/Berlin)”, or a Codex date such as “try again at Oct 14th, 2026 9:36 AM”. Times without a zone are read in the daemon machine's time zone. A stop with neither a quota reset nor a readable time stays pending until usable quota information arrives.

Paseo refreshes usage data every five minutes, so a resume can follow the reset by a few minutes. An empty prepaid credit balance never resets and does not start a wait; providers that Paseo reports no usage for, such as models routed through another harness, resume only when their message states a wait time.

Use `/wakeup` in a chat to inspect its pending wake-up, or `/wakeup cancel` to cancel it. Manually prompting or archiving the agent also cancels its wait. Successful turns and unrelated failures are left alone.

Requires Paseo 0.11.1 or later on the daemon and client. Activation applies to new usage-limit stops across that daemon and allows automatic quota consumption when work resumes. No additional accounts or tokens are needed; the plugin uses Paseo's existing provider connections.

Pending waits are saved locally. After a daemon or plugin restart, a connected Paseo client or lifecycle event must reattach the scheduler before it can resume. Once attached, it continues working with the client closed while the daemon stays running. Removing a wait before sending prevents duplicate prompts after an uncertain acknowledgement; a failed send may require manual continuation. Disabling or removing the plugin leaves the saved queue on disk.

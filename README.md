# Paseo Wake-up

Wake-up automatically continues the same Paseo chat after a provider usage limit resets. It keeps the conversation and completed work in the original agent session, so you do not have to watch the clock and send a continuation manually.

For example, when Claude reports a session limit or Codex reports a weekly limit, Wake-up records the reset time, waits, checks quota, and sends a short continuation into that chat.

## How it works

1. A new agent turn ends with a recognized usage-limit stop.
2. The plugin reads Paseo's provider usage windows and any reset time reported in the stop message.
3. It waits until the latest applicable reset plus a one-minute buffer.
4. It checks the session and quota again, then asks the same agent to continue unfinished work.

It supports short and weekly quota windows, relative waits such as “try again in 15 minutes,” Claude clock times such as “resets 2:20am (Europe/Berlin),” and Codex date/time messages. An unknown reset stays pending; an empty non-resetting credit balance does not trigger a guessed wake-up.

No original prompt, attachment, or tool action is replayed. The continuation asks the agent to preserve completed work and stop if the task is already finished.

## Install

Requirements:

- Paseo **0.11.1 or later** on the daemon and client.
- Plugins enabled in **Settings → Plugins → Enable plugins**. Paseo plugins run as trusted code with the daemon user's access.
- An existing provider connection in Paseo. No extra account or API key is needed.
- Access to this repository while it is private.

The example uses `~/Documents/Development`; another directory works too.

```sh
mkdir -p ~/Documents/Development
cd ~/Documents/Development
git clone git@github.com:InfinityMod/paseo-wakeup.git
cd paseo-wakeup
paseo plugin install "$PWD"
paseo plugin ls
```

The installed ID is `paseo-wakeup`. Install one copy per daemon; separate daemons need distinct `PASEO_HOME` values.

## Use it

When enabled, the plugin watches new usage-limit stops automatically. There is no per-chat setup.

| Action                   | Result                                                   |
| ------------------------ | -------------------------------------------------------- |
| `/wakeup` in a chat      | Shows that chat's pending wake-up and reset information. |
| `/wakeup cancel`         | Cancels its automatic continuation.                      |
| Prompt the chat manually | Cancels its pending wake-up.                             |
| Archive the agent        | Cancels its pending wake-up.                             |

The daemon must stay running to deliver a continuation. Automatic resumes can spend quota and continue the agent's existing task with its existing permissions.

To stop automatic resumes while keeping saved waits:

```sh
paseo plugin disable paseo-wakeup
```

Enable it again with:

```sh
paseo plugin enable paseo-wakeup
```

## Waiting, restarts, and saved state

The scheduler checks every 30 seconds. Paseo may cache usage information for five minutes, so a continuation can arrive a few minutes after the reset and buffer. A healthy quota snapshot from before the reset cannot authorize an early resume.

Pending waits are stored in `$PASEO_HOME/plugin-state/paseo-wakeup.json`, normally `~/.paseo/plugin-state/paseo-wakeup.json`. Reloading, disabling, or removing the plugin leaves that queue on disk. Re-enabling can restore it.

After a plugin or daemon restart, a connected Paseo client or new lifecycle event must reattach the scheduler to Paseo's SDK. The client does this automatically. Once attached, it continues working with the client closed while the daemon stays running. Chats manually continued during downtime are removed from the restored queue.

The plugin leaves running sessions and sessions waiting for permission alone. When a send is due, it removes the saved wait before delivery to avoid duplicate continuations after an uncertain acknowledgement. A crash or failed send in that interval can require manual continuation; check the logs.

## Limits

- Stops from before installation are not backfilled. The plugin watches new turns.
- If neither the provider usage nor its message gives a usable reset, the wait remains pending until usable information arrives.
- Providers running through a harness with no matching usage entry depend on a readable reset in their message.
- Times without an explicit zone are interpreted in the daemon machine's time zone.
- Multiple exhausted windows are treated conservatively: all relevant limits must reset before a quota-based resume.
- Detection depends on provider stop codes and wording. New provider wording may require an update; skipped stops are logged.

The plugin uses Paseo's existing connections and local saved state. It sends no requests to a separate classification service.

## Troubleshoot and develop

```sh
paseo plugin ls
paseo plugin logs paseo-wakeup
paseo plugin reload paseo-wakeup
```

If a chat stays stopped, inspect `/wakeup` and the logs for a missing reset, stale usage, an unattached scheduler, or a failed continuation. Manually prompting the chat cancels its old wait; a new usage-limit stop can schedule another.

Development requires **Node.js 24 or later**:

```sh
npm ci --ignore-scripts
npm run check
```

The check typechecks against the pinned Paseo SDK, runs deterministic tests, and checks Prettier formatting. Tests cover observed stop messages, multiple limits, stale quota, restarts, cancellation races, and atomic state storage. `server/wakeup.ts` owns scheduling; the runtime and SDK adapter connect it to Paseo. This repository develops independently of the Lumvise checkout.

See [the overview](OVERVIEW.md) for the plugin listing and [Paseo discussion #4122](https://github.com/getpaseo/paseo/discussions/4122) for the original proposal.

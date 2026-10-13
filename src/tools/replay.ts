import type { HostEvent } from "../ir/callables";
import type { Capability } from "../stdlib/host";
import { CAPABILITIES } from "../stdlib/host";
import { sha256 } from "./sha256";

// The replay artifact (docs/v2-replay.md): a recorded run's committed effects, bound to
// the exact program that made them.
//
//   Y3REPLAY 1
//   {"magic":"Y3REPLAY","version":1,"toolchain":…,"program":"<sha256 of the Y3BC artifact>",
//    "capabilities":{…},"events":[…],"integrity":"<sha256 of the events>"}
//
// A program is identified by the hash of its bytecode artifact, never by a path. The
// integrity hash catches a truncated or edited log.

export const REPLAY_MAGIC = "Y3REPLAY";
export const REPLAY_VERSION = 1;
export const TOOLCHAIN = "y3 0.1.0 (Y3BC 3)";

export class ReplayError extends Error {}

export type Replay = {
  readonly magic: string;
  readonly version: number;
  readonly toolchain: string;
  readonly program: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly events: readonly HostEvent[];
  readonly integrity: string;
};

export const programHash = (artifact: string): string => sha256(artifact);

export function writeReplay(artifact: string, events: readonly HostEvent[], capabilities: Partial<Record<Capability, boolean>> = {}): string {
  const replay: Replay = {
    magic: REPLAY_MAGIC,
    version: REPLAY_VERSION,
    toolchain: TOOLCHAIN,
    program: programHash(artifact),
    capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, capabilities[c] !== false])) as Record<Capability, boolean>,
    events,
    integrity: sha256(JSON.stringify(events)),
  };
  return `${REPLAY_MAGIC} ${REPLAY_VERSION}\n${JSON.stringify(replay)}\n`;
}

// Reads a replay for this program, refusing anything that does not belong to it.
export function readReplay(text: string, artifact: string, options: { force?: boolean } = {}): Replay {
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  const match = header.match(/^Y3REPLAY (\d+)$/);
  if (!match) throw new ReplayError("not a Y3 replay (no 'Y3REPLAY <version>' header)");
  if (Number(match[1]) !== REPLAY_VERSION) throw new ReplayError(`replay version ${match[1]} is not supported: this toolchain reads version ${REPLAY_VERSION}`);
  let replay: Replay;
  try {
    replay = JSON.parse(text.slice(newline + 1)) as Replay;
  } catch {
    throw new ReplayError("the replay is truncated or not valid JSON");
  }
  if (replay.magic !== REPLAY_MAGIC || replay.version !== REPLAY_VERSION || !Array.isArray(replay.events)) throw new ReplayError("the replay's header and body disagree");
  if (sha256(JSON.stringify(replay.events)) !== replay.integrity) throw new ReplayError("the replay's events do not match its integrity hash: it was truncated or edited");
  if (replay.program !== programHash(artifact) && !options.force) {
    throw new ReplayError(`this replay was recorded for program ${replay.program.slice(0, 12)}…, not for this one (${programHash(artifact).slice(0, 12)}…); use --force to replay it anyway`);
  }
  return replay;
}

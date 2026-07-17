import type {
  AvalElement,
  AvalElementAttributes,
  AvalErrorDetail,
  AvalFit,
  AvalReadinessChangeDetail,
  AvalSourceCandidate,
  StaticReason
} from "@pixel-point/aval-element";
import { ELEMENT_DECODER_CAPACITY } from "@pixel-point/aval-element";

declare const element: AvalElement;
declare const detail: Readonly<AvalErrorDetail>;
declare const readinessDetail: Readonly<AvalReadinessChangeDetail>;

const decoderWorkers: 2 = ELEMENT_DECODER_CAPACITY.workerCount;
void decoderWorkers;

element.motion = "auto";
element.autoplay = "manual";
element.fit = "cover" satisfies AvalFit;
element.state = "author.state";
void element.prepare({ timeoutMs: 1_000 });
void element.setState("author.state");
element.send("author.event");
element.readyFor("author.state");
element.pause();
void element.resume();
element.getDiagnostics({ trace: true });

const attributes: AvalElementAttributes = {
  motion: "reduce",
  autoplay: "visible",
  fit: "contain",
  state: "idle",
  width: 128
};
void attributes;
const sourceCandidate: AvalSourceCandidate = {
  src: "/motion.av1.avl",
  type: 'application/vnd.aval; codecs="av01.0.08M.10"',
  codec: "av01.0.08M.10",
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
};
void sourceCandidate;

// @ts-expect-error source children are the sole source authority
element.src = "/motion.avl";
// @ts-expect-error integrity belongs to each direct source child
element.integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
void detail.failure.code;
const readinessReason: StaticReason | undefined = readinessDetail.reason;
void readinessReason;

// @ts-expect-error motion is a closed union
element.motion = "sometimes";
// @ts-expect-error staged properties are read-only
element.visualState = "forged";
// @ts-expect-error immutable failure detail
detail.fatal = false;
// @ts-expect-error fit is closed
const badFit: AvalFit = "scale-down";
void badFit;

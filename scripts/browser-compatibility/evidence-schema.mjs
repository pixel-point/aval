import {
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";

export const SHA256_PATTERN = "^[a-f0-9]{64}$";
export const COMMIT_PATTERN = "^[a-f0-9]{40}$";
export const SESSION_ID_PATTERN =
  "^[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,47})?$";

const IDENTIFIER_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const RELATIVE_PATH_PATTERN =
  "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$";
const CODECS = SOURCE_CODEC_PRIORITY;
const STATES = ["idle", "engaged", "entering", "hover", "exiting"];

const sha256 = Object.freeze({ type: "string", pattern: SHA256_PATTERN });
const identifier = Object.freeze({ type: "string", pattern: IDENTIFIER_PATTERN });
const relativePath = Object.freeze({
  type: "string",
  pattern: RELATIVE_PATH_PATTERN,
  maxLength: 512
});
const dateTime = Object.freeze({ type: "string", format: "date-time" });
const safeInteger = Object.freeze({
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER
});
const playbackLifecycle = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "outputsAccepted",
    "drawsCompleted",
    "logicalRunsCreated",
    "candidateCommits",
    "runsClosed",
    "transitionStarts",
    "transitionEnds",
    "loopCrossings",
    "nativeDecoderCreatesByLane",
    "nativeDecoderClosesByLane"
  ],
  properties: {
    outputsAccepted: safeInteger,
    drawsCompleted: safeInteger,
    logicalRunsCreated: safeInteger,
    candidateCommits: safeInteger,
    runsClosed: safeInteger,
    transitionStarts: safeInteger,
    transitionEnds: safeInteger,
    loopCrossings: safeInteger,
    nativeDecoderCreatesByLane: {
      type: "array",
      prefixItems: [safeInteger, safeInteger],
      items: false,
      minItems: 2,
      maxItems: 2
    },
    nativeDecoderClosesByLane: {
      type: "array",
      prefixItems: [safeInteger, safeInteger],
      items: false,
      minItems: 2,
      maxItems: 2
    }
  }
});

export const EVIDENCE_MANIFEST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://aval.local/schemas/browser-evidence-manifest-1.0.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "sessionId",
    "createdAt",
    "sourceAttestation",
    "slots"
  ],
  properties: {
    schemaVersion: { const: 1 },
    sessionId: { type: "string", pattern: SESSION_ID_PATTERN },
    createdAt: dateTime,
    sourceAttestation: { $ref: "#/$defs/sourceAttestation" },
    slots: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: { $ref: "#/$defs/slot" }
    }
  },
  $defs: {
    sourceAttestation: {
      type: "object",
      additionalProperties: false,
      required: [
        "headCommit",
        "trackedDiffSha256",
        "untrackedSourceTreeSha256",
        "policySha256",
        "servedTreeSha256"
      ],
      properties: {
        headCommit: { type: "string", pattern: COMMIT_PATTERN },
        trackedDiffSha256: sha256,
        untrackedSourceTreeSha256: sha256,
        policySha256: sha256,
        servedTreeSha256: sha256
      }
    },
    slot: {
      type: "object",
      additionalProperties: false,
      required: ["slotId", "sessionPath", "cases"],
      properties: {
        slotId: identifier,
        sessionPath: relativePath,
        cases: {
          type: "array",
          minItems: 8,
          maxItems: 16,
          items: { $ref: "#/$defs/case" }
        }
      }
    },
    case: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "demoId",
        "mode",
        "expectedOutcome",
        "expectedAuthoredCodecs",
        "selectedCodec",
        "checkpoints",
        "ledgerPath"
      ],
      properties: {
        id: identifier,
        demoId: {
          enum: [
            "end-user-playground",
            "grass-rabbit",
            "grass-rabbit-codecs",
            "kinetic-orb"
          ]
        },
        mode: { enum: ["forced-h264", "full-ladder"] },
        expectedOutcome: { enum: ["playback", "deterministic-error"] },
        expectedAuthoredCodecs: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { enum: CODECS }
        },
        selectedCodec: {
          oneOf: [
            { enum: CODECS },
            { type: "null" }
          ]
        },
        checkpoints: {
          type: "array",
          minItems: 2,
          maxItems: 64,
          items: { $ref: "#/$defs/checkpoint" }
        },
        ledgerPath: relativePath
      }
    },
    checkpoint: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "visualState",
        "advancingFrame",
        "reportPath",
        "pngPath",
        "contextPngPath",
        "frameProof"
      ],
      properties: {
        id: identifier,
        visualState: { oneOf: [{ enum: STATES }, { type: "null" }] },
        advancingFrame: { type: "boolean" },
        reportPath: relativePath,
        pngPath: relativePath,
        contextPngPath: relativePath,
        frameProof: {
          oneOf: [
            { $ref: "#/$defs/frameProof" },
            { type: "null" }
          ]
        }
      }
    },
    frameProof: {
      type: "object",
      additionalProperties: false,
      required: [
        "beforePngPath",
        "sampleIntervalMilliseconds",
        "beforeDrawsCompleted",
        "afterDrawsCompleted"
      ],
      properties: {
        beforePngPath: relativePath,
        sampleIntervalMilliseconds: {
          type: "number",
          minimum: 1,
          maximum: 5_000
        },
        beforeDrawsCompleted: safeInteger,
        afterDrawsCompleted: safeInteger
      }
    }
  }
});

export const EVIDENCE_SESSION_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://aval.local/schemas/browser-evidence-session-1.0.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "sessionId",
    "slotId",
    "provider",
    "sourceCommit",
    "tunnelUrl",
    "tunnelCreatedAt",
    "testedAt",
    "os",
    "device",
    "browser"
  ],
  properties: {
    schemaVersion: { const: 1 },
    sessionId: { type: "string", pattern: SESSION_ID_PATTERN },
    slotId: identifier,
    provider: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sessionId"],
      properties: {
        kind: {
          enum: [
            "browserstack-live",
            "managed-macos-arm64",
            "github-hosted-windows-x64"
          ]
        },
        sessionId: {
          type: "string",
          pattern: "^[A-Za-z0-9_-]{8,128}$"
        }
      }
    },
    sourceCommit: { type: "string", pattern: COMMIT_PATTERN },
    tunnelUrl: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2048
    },
    tunnelCreatedAt: dateTime,
    testedAt: dateTime,
    os: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        version: { type: "string", minLength: 1, maxLength: 32 }
      }
    },
    device: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 }
          }
        }
      ]
    },
    browser: {
      type: "object",
      additionalProperties: false,
      required: ["brand", "version", "engine", "engineVersion"],
      properties: {
        brand: { enum: ["Chrome", "Firefox", "Safari", "Brave"] },
        version: {
          type: "string",
          pattern: "^[0-9]+(?:\\.[0-9]+){1,3}$",
          maxLength: 32
        },
        engine: { enum: ["Chromium", "Gecko", "WebKit"] },
        engineVersion: {
          oneOf: [
            {
              type: "string",
              pattern: "^[0-9]+(?:\\.[0-9]+){1,3}$",
              maxLength: 32
            },
            { type: "null" }
          ]
        }
      }
    }
  }
});

export const INTERACTION_LEDGER_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://aval.local/schemas/browser-interaction-ledger-1.0.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "slotId",
    "demoId",
    "mode",
    "interactionProfile",
    "startedAt",
    "finishedAt",
    "terminalFailures",
    "events",
    "visualCheckpoints",
    "soak"
  ],
  properties: {
    schemaVersion: { const: 1 },
    slotId: identifier,
    demoId: {
      enum: [
        "end-user-playground",
        "grass-rabbit",
        "grass-rabbit-codecs",
        "kinetic-orb"
      ]
    },
    mode: { enum: ["forced-h264", "full-ladder"] },
    interactionProfile: { enum: ["desktop", "touch", "unsupported"] },
    startedAt: dateTime,
    finishedAt: dateTime,
    terminalFailures: safeInteger,
    events: {
      type: "array",
      minItems: 0,
      maxItems: 4096,
      items: { $ref: "#/$defs/event" }
    },
    visualCheckpoints: {
      type: "array",
      minItems: 2,
      maxItems: 64,
      items: { $ref: "#/$defs/visualCheckpoint" }
    },
    soak: { $ref: "#/$defs/soak" }
  },
  $defs: {
    event: {
      type: "object",
      additionalProperties: false,
      required: ["type", "atMilliseconds", "from", "to", "edge"],
      properties: {
        type: { enum: ["transitionstart", "visualstatechange", "transitionend"] },
        atMilliseconds: { type: "number", minimum: 0 },
        from: { type: ["string", "null"], maxLength: 64 },
        to: { type: ["string", "null"], maxLength: 64 },
        edge: { type: ["string", "null"], maxLength: 129 }
      }
    },
    visualCheckpoint: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "visualState",
        "advancingFrame",
        "pngSha256",
        "contextPngSha256",
        "frameProof"
      ],
      properties: {
        id: identifier,
        visualState: { oneOf: [{ enum: STATES }, { type: "null" }] },
        advancingFrame: { type: "boolean" },
        pngSha256: sha256,
        contextPngSha256: sha256,
        frameProof: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "beforePngSha256",
                "afterPngSha256",
                "sampleIntervalMilliseconds",
                "beforeDrawsCompleted",
                "afterDrawsCompleted"
              ],
              properties: {
                beforePngSha256: sha256,
                afterPngSha256: sha256,
                sampleIntervalMilliseconds: {
                  type: "number",
                  minimum: 1,
                  maximum: 5_000
                },
                beforeDrawsCompleted: safeInteger,
                afterDrawsCompleted: safeInteger
              }
            },
            { type: "null" }
          ]
        }
      }
    },
    soak: {
      type: "object",
      additionalProperties: false,
      required: ["requiredMilliseconds", "elapsedMilliseconds", "samples"],
      properties: {
        requiredMilliseconds: { type: "number", minimum: 0 },
        elapsedMilliseconds: { type: "number", minimum: 0 },
        samples: {
          type: "array",
          minItems: 2,
          maxItems: 128,
          items: { $ref: "#/$defs/soakSample" }
        }
      }
    },
    soakSample: {
      type: "object",
      additionalProperties: false,
      required: ["elapsedMilliseconds", "terminalFailures", "counters"],
      properties: {
        elapsedMilliseconds: { type: "number", minimum: 0 },
        terminalFailures: safeInteger,
        counters: { $ref: "#/$defs/counters" }
      }
    },
    counters: {
      type: "object",
      additionalProperties: false,
      required: [
        "outputsAccepted",
        "drawsCompleted",
        "logicalRunsCreated",
        "candidateCommits",
        "runsClosed",
        "transitionStarts",
        "transitionEnds",
        "loopCrossings",
        "nativeDecoderCreatesByLane",
        "nativeDecoderClosesByLane"
      ],
      properties: {
        outputsAccepted: safeInteger,
        drawsCompleted: safeInteger,
        logicalRunsCreated: safeInteger,
        candidateCommits: safeInteger,
        runsClosed: safeInteger,
        transitionStarts: safeInteger,
        transitionEnds: safeInteger,
        loopCrossings: safeInteger,
        nativeDecoderCreatesByLane: {
          type: "array",
          prefixItems: [safeInteger, safeInteger],
          items: false,
          minItems: 2,
          maxItems: 2
        },
        nativeDecoderClosesByLane: {
          type: "array",
          prefixItems: [safeInteger, safeInteger],
          items: false,
          minItems: 2,
          maxItems: 2
        }
      }
    }
  }
});

export const DIAGNOSTIC_REPORT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://aval.local/schemas/browser-diagnostic-report-1.0.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "generatedAt",
    "serializationBudgetExhausted",
    "session",
    "environment",
    "players",
    "authoredSources",
    "checkpoints",
    "latest"
  ],
  properties: {
    schemaVersion: { const: 1 },
    generatedAt: dateTime,
    serializationBudgetExhausted: { type: "boolean" },
    session: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          pattern: "^/[^?#]*\\?avalDiagnostics=1(?:&avalCertificationMode=(?:forced-h264|full-ladder))?$",
          maxLength: 2048
        }
      }
    },
    environment: {
      type: "object",
      required: ["userAgent", "userAgentData", "capabilities"],
      properties: {
        userAgent: { type: "string", minLength: 1, maxLength: 4_096 },
        userAgentData: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              required: ["brands", "mobile", "platform"],
              properties: {
                brands: {
                  type: "array",
                  maxItems: 32,
                  items: {
                    type: "object",
                    required: ["brand", "version"],
                    properties: {
                      brand: { type: "string", minLength: 1, maxLength: 128 },
                      version: { type: "string", minLength: 1, maxLength: 32 }
                    }
                  }
                },
                mobile: { type: "boolean" },
                platform: { type: "string", maxLength: 128 }
              }
            }
          ]
        },
        capabilities: {
          type: "object",
          required: ["braveBrandApi"],
          properties: {
            braveBrandApi: { type: "boolean" }
          }
        }
      }
    },
    players: { type: "array" },
    authoredSources: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        type: "object",
        required: ["playerId", "index", "codec"],
        properties: {
          playerId: { type: "string", minLength: 1, maxLength: 64 },
          index: safeInteger,
          codec: { enum: CODECS }
        }
      }
    },
    checkpoints: { type: "array", maxItems: 32 },
    latest: {
      type: "object",
      required: ["playerId", "element"],
      properties: {
        playerId: { type: "string", minLength: 1, maxLength: 64 },
        element: {
          type: "object",
          required: ["readiness", "visualState", "diagnostics"],
          properties: {
            readiness: { enum: ["interactiveReady", "error"] },
            visualState: { oneOf: [{ enum: STATES }, { type: "null" }] },
            diagnostics: {
              type: "object",
              required: [
                "lastFailure",
                "sourceGeneration",
                "outstanding",
                "terminalCleanup",
                "runtime",
                "presentation"
              ],
              properties: {
                lastFailure: { oneOf: [{ type: "null" }, { type: "object" }] },
                sourceGeneration: safeInteger,
                outstanding: {
                  type: "object",
                  maxProperties: 64,
                  additionalProperties: safeInteger
                },
                terminalCleanup: {
                  oneOf: [
                    { type: "null" },
                    {
                      type: "object",
                      required: ["completed", "sourceCleanupCompleted"],
                      properties: {
                        completed: { type: "boolean" },
                        sourceCleanupCompleted: { type: "boolean" }
                      }
                    }
                  ]
                },
                runtime: {
                  type: "object",
                  required: [
                    "selectedCodec",
                    "selectedRendition",
                    "activeTransportBodies",
                    "pendingLoads",
                    "interestedWaiters",
                    "activeLeaseCount",
                    "pageActiveDecoderSlotCount",
                    "pageQueuedDecoderTicketCount",
                    "pageParkedDecoderTicketCount",
                    "pageParticipantCount",
                    "cleanupFailureCount",
                    "playbackLifecycle",
                    "decoderDiagnostics",
                    "rendererDiagnostics"
                  ],
                  properties: {
                    selectedRendition: {
                      oneOf: [
                        { type: "string", minLength: 1, maxLength: 128 },
                        { type: "null" }
                      ]
                    },
                    selectedCodec: {
                      oneOf: [
                        { type: "string", minLength: 1, maxLength: 128 },
                        { type: "null" }
                      ]
                    },
                    activeTransportBodies: safeInteger,
                    pendingLoads: safeInteger,
                    interestedWaiters: safeInteger,
                    activeLeaseCount: safeInteger,
                    pageActiveDecoderSlotCount: safeInteger,
                    pageQueuedDecoderTicketCount: safeInteger,
                    pageParkedDecoderTicketCount: safeInteger,
                    pageParticipantCount: safeInteger,
                    cleanupFailureCount: safeInteger,
                    playbackLifecycle,
                    decoderDiagnostics: {
                      type: "array",
                      maxItems: 64
                    },
                    rendererDiagnostics: {
                      type: "array",
                      maxItems: 64
                    }
                  }
                },
                presentation: {
                  type: "object",
                  required: ["backingWidth", "backingHeight"],
                  properties: {
                    backingWidth: { type: "number", minimum: 0 },
                    backingHeight: { type: "number", minimum: 0 }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
});

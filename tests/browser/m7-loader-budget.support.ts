import { expect, type Page } from "@playwright/test";

import type {
  M7DecoderFifoProof,
  M7LoaderProofFailure,
  M7LoaderProofSuccess,
  M7LoaderTerminalSnapshot
} from "../../apps/playground/src/m7-loader-budget-proof.js";
import type { M7LoaderTelemetry } from
  "../../apps/playground/src/m7-loader-instrumentation.js";
import type { M7SessionPlayerProofReport } from
  "../../apps/playground/src/m7-session-player-proof.js";

export interface M7HttpMetrics {
  readonly requests: readonly {
    readonly ordinal: number;
    readonly method: string;
    readonly range: string | null;
    readonly ifRange: string | null;
    readonly scenario: string;
  }[];
  readonly activeResponses: number;
  readonly peakActiveResponses: number;
  readonly completedResponses: number;
  readonly cancelledResponses: number;
}

export type M7LoaderReport = M7LoaderProofSuccess | M7LoaderProofFailure;
export type M7SessionPlayerReport = M7SessionPlayerProofReport;
export type { M7DecoderFifoProof, M7LoaderTelemetry };

export const ZERO_TERMINAL = Object.freeze({
  physicalBytes: 0,
  byteLeases: 0,
  participants: 0,
  decoderLeases: 0,
  decoderQueue: 0
}) satisfies Readonly<M7LoaderTerminalSnapshot>;

export async function metrics(
  page: Page,
  session: string
): Promise<M7HttpMetrics> {
  return page.evaluate(async (session) => {
    const response = await fetch(`/__m7__/metrics?session=${session}`, {
      cache: "no-store"
    });
    return response.json();
  }, session) as Promise<M7HttpMetrics>;
}

export function assertLoaderTelemetryTerminal(
  telemetry: Readonly<M7LoaderTelemetry>
): void {
  expect(telemetry.activeBodies).toBe(0);
  expect(telemetry.activeReaders).toBe(0);
  expect(telemetry.timers.pending).toBe(0);
  expect(telemetry.timers.scheduled).toBe(
    telemetry.timers.cleared + telemetry.timers.fired
  );
  expect(telemetry.resources.reservationAttempts).toBe(
    telemetry.resources.reservationSuccesses +
      telemetry.resources.reservationFailures
  );
  expect(telemetry.bodies.every((body) =>
    body.completed || body.cancelled || body.readFailed
  )).toBe(true);
}

export async function loaderProof(
  page: Page,
  session: string,
  scenario: string,
  options: Readonly<{
    initialStatic: string;
    rendition: string;
    integrity?: string;
    stopAfter?: string;
    timeoutMs?: number;
    abortAfterMs?: number;
  }>
): Promise<M7LoaderReport> {
  return page.evaluate(async ({ session, scenario, options }) => {
    const moduleUrl = "/src/m7-loader-budget-proof.ts";
    const proof = await import(/* @vite-ignore */ moduleUrl) as {
      runM7LoaderProof(input: Readonly<{
        assetUrl: string;
        initialStatic: string;
        rendition: string;
        integrity?: string;
        stopAfter?: string;
        timeoutMs?: number;
        abortAfterMs?: number;
      }>): Promise<M7LoaderReport>;
    };
    return proof.runM7LoaderProof({
      assetUrl: new URL(
        `/__m7__/asset?session=${session}&scenario=${scenario}`,
        globalThis.location.href
      ).href,
      initialStatic: options.initialStatic,
      rendition: options.rendition,
      ...(options.integrity === undefined
        ? {}
        : { integrity: options.integrity }),
      ...(options.stopAfter === undefined
        ? {}
        : { stopAfter: options.stopAfter }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.abortAfterMs === undefined
        ? {}
        : { abortAfterMs: options.abortAfterMs })
    });
  }, { session, scenario, options });
}

export async function sessionPlayerProof(
  page: Page,
  session: string
): Promise<M7SessionPlayerReport> {
  return page.evaluate(async (session) => {
    const moduleUrl = "/src/m7-session-player-proof.ts";
    const proof = await import(/* @vite-ignore */ moduleUrl) as {
      runM7SessionPlayerProof(input: Readonly<{
        assetUrl: string;
        metricsUrl: string;
      }>): Promise<M7SessionPlayerReport>;
    };
    return proof.runM7SessionPlayerProof({
      assetUrl: new URL(
        `/__m7__/asset?session=${session}&scenario=exact-range`,
        globalThis.location.href
      ).href,
      metricsUrl: new URL(
        `/__m7__/metrics?session=${session}`,
        globalThis.location.href
      ).href
    });
  }, session);
}

export async function decoderFifoProof(
  page: Page,
  sessions: readonly [string, string, string]
): Promise<M7DecoderFifoProof> {
  return runDecoderFifoProof(page, sessions.map((session) => ({
    assetPath: `/__m7__/asset?session=${session}&scenario=exact-range`,
    metricsPath: `/__m7__/metrics?session=${session}`
  })));
}

export async function decoderFifoFailureProof(
  page: Page,
  routes: readonly Readonly<{
    assetPath: string;
    metricsPath: string;
  }>[]
): Promise<string | null> {
  try {
    await runDecoderFifoProof(page, routes);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runDecoderFifoProof(
  page: Page,
  routes: readonly Readonly<{
    assetPath: string;
    metricsPath: string;
  }>[]
): Promise<M7DecoderFifoProof> {
  return page.evaluate(async (routes) => {
    const moduleUrl = "/src/m7-loader-budget-proof.ts";
    const proof = await import(/* @vite-ignore */ moduleUrl) as {
      runM7DecoderFifoProof(input: Readonly<{
        players: readonly Readonly<{
          assetUrl: string;
          metricsUrl: string;
        }>[];
      }>): Promise<M7DecoderFifoProof>;
    };
    return proof.runM7DecoderFifoProof({
      players: routes.map((route) => ({
        assetUrl: new URL(route.assetPath, globalThis.location.href).href,
        metricsUrl: new URL(route.metricsPath, globalThis.location.href).href
      }))
    });
  }, routes);
}

export function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

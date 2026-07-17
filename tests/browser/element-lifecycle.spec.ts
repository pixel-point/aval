import { expect, test, type Page } from "@playwright/test";

type PlayerDiagnostics = Readonly<{
  sourceGeneration: number;
  readiness: string;
  mode: string | null;
  staticReason: string | null;
  elementOwnership: Readonly<{
    listenerCount: number;
    observerCount: number;
  }>;
  outstanding: Readonly<Record<string, number>>;
  runtime: Readonly<{
    pageParticipantCount: number;
    pageActiveDecoderLeaseCount: number;
    pageQueuedDecoderTicketCount: number;
    activeLeaseCount: number;
    decoderLeaseState: string | null;
    selectedCodec: string | null;
  }>;
  visibility: Readonly<{
    intersecting: boolean;
    positiveBox: boolean;
    effectivelyVisible: boolean;
    observerSupported: boolean;
  }>;
}>;

type AvalPlayerElement = HTMLElement & {
  prepare(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
  getDiagnostics(): PlayerDiagnostics;
  dispose(): Promise<void>;
};

test("rapid adopt-and-append installs final-realm owners only once", async ({ page }) => {
  await loadDefinition(page, "rapid-adoption");

  const counts = await page.evaluate(async () => {
    type RealmCounts = {
      documentVisibilityListeners: number;
      windowResizeListeners: number;
      pageHideListeners: number;
      pageShowListeners: number;
      intersectionObservers: number;
      resizeObservers: number;
    };

    const createRealm = (): {
      frame: HTMLIFrameElement;
      document: Document;
      counts: RealmCounts;
    } => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const realmWindow = frame.contentWindow!;
      const realmDocument = frame.contentDocument!;
      const counts: RealmCounts = {
        documentVisibilityListeners: 0,
        windowResizeListeners: 0,
        pageHideListeners: 0,
        pageShowListeners: 0,
        intersectionObservers: 0,
        resizeObservers: 0
      };

      const addDocumentListener = realmDocument.addEventListener.bind(realmDocument);
      realmDocument.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void => {
        if (type === "visibilitychange") counts.documentVisibilityListeners += 1;
        Reflect.apply(addDocumentListener, realmDocument, [type, listener, options]);
      }) as Document["addEventListener"];

      const addWindowListener = realmWindow.addEventListener.bind(realmWindow);
      realmWindow.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void => {
        if (type === "resize") counts.windowResizeListeners += 1;
        if (type === "pagehide") counts.pageHideListeners += 1;
        if (type === "pageshow") counts.pageShowListeners += 1;
        Reflect.apply(addWindowListener, realmWindow, [type, listener, options]);
      }) as Window["addEventListener"];

      const realm = realmWindow as Window & typeof globalThis;
      const NativeIntersectionObserver = realm.IntersectionObserver;
      Object.defineProperty(realmWindow, "IntersectionObserver", {
        configurable: true,
        value: function CountingIntersectionObserver(
          callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit
        ): IntersectionObserver {
          counts.intersectionObservers += 1;
          return new NativeIntersectionObserver(callback, options);
        }
      });

      const NativeResizeObserver = realm.ResizeObserver;
      Object.defineProperty(realmWindow, "ResizeObserver", {
        configurable: true,
        value: function CountingResizeObserver(
          callback: ResizeObserverCallback
        ): ResizeObserver {
          counts.resizeObservers += 1;
          return new NativeResizeObserver(callback);
        }
      });

      return { frame, document: realmDocument, counts };
    };

    const middle = createRealm();
    const final = createRealm();
    const element = document.createElement("aval-player") as unknown as AvalPlayerElement;
    document.body.append(element);

    middle.document.adoptNode(element);
    middle.document.body.append(element);
    final.document.adoptNode(element);
    final.document.body.append(element);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const diagnostics = element.getDiagnostics();
    const result = {
      middle: middle.counts,
      final: final.counts,
      logicalOwners: {
        listeners: diagnostics.elementOwnership.listenerCount,
        observers: diagnostics.elementOwnership.observerCount
      }
    };

    await element.dispose().catch(() => undefined);
    middle.frame.remove();
    final.frame.remove();
    return result;
  });

  expect(counts.middle).toMatchObject({
    documentVisibilityListeners: 1,
    windowResizeListeners: 1,
    pageHideListeners: 1,
    pageShowListeners: 1,
    intersectionObservers: 1,
    resizeObservers: 1
  });
  expect(counts.final).toEqual({
    documentVisibilityListeners: 1,
    windowResizeListeners: 1,
    pageHideListeners: 1,
    pageShowListeners: 1,
    intersectionObservers: 1,
    resizeObservers: 1
  });
  expect(counts.logicalOwners).toEqual({ listeners: 5, observers: 3 });
});

test("decoder limits and accounting follow the captured window across adoption", async ({
  browserName,
  page
}) => {
  test.skip(
    browserName !== "chromium",
    "requires WebCodecs animation and active decoder leases; Firefox/WebKit correctly use static fallback"
  );
  test.setTimeout(90_000);
  await loadDefinition(page, "decoder-realm-adoption", true);

  const result = await page.evaluate(async () => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly ready: Promise<void>;
        readonly player: AvalPlayerElement;
      };
    }).avalSourcePlayground;
    await api.ready;
    const main = api.player;

    const sourceTemplates = [...main.querySelectorAll(":scope > source")];
    const createPlayer = (): AvalPlayerElement => {
      const player = document.createElement("aval-player") as unknown as AvalPlayerElement;
      player.setAttribute("crossorigin", "anonymous");
      player.setAttribute("autoplay", "visible");
      player.setAttribute("width", "320");
      player.setAttribute("height", "180");
      player.style.cssText =
        "position:fixed;inset:0 auto auto 0;width:320px;height:180px;opacity:.01;pointer-events:none";
      player.append(...sourceTemplates.map((source) => source.cloneNode(true)));
      return player;
    };
    const snapshot = (player: AvalPlayerElement) => {
      const diagnostics = player.getDiagnostics();
      return {
        readiness: diagnostics.readiness,
        mode: diagnostics.mode,
        staticReason: diagnostics.staticReason,
        localLease: diagnostics.runtime.activeLeaseCount,
        decoderState: diagnostics.runtime.decoderLeaseState,
        page: {
          participants: diagnostics.runtime.pageParticipantCount,
          active: diagnostics.runtime.pageActiveDecoderLeaseCount,
          queued: diagnostics.runtime.pageQueuedDecoderTicketCount
        }
      };
    };

    const frame = document.createElement("iframe");
    frame.style.cssText =
      "position:fixed;inset:0 auto auto 0;width:640px;height:360px;border:0;opacity:.01;pointer-events:none";
    document.body.append(frame);
    const secondDocument = frame.contentDocument!;

    const adopted = createPlayer();
    document.body.append(adopted);
    await adopted.prepare({ timeoutMs: 30_000 });
    const beforeAdoption = {
      main: snapshot(main),
      adopted: snapshot(adopted)
    };

    secondDocument.adoptNode(adopted);
    secondDocument.body.append(adopted);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await adopted.prepare({ timeoutMs: 30_000 });
    const afterAdoption = {
      main: snapshot(main),
      adopted: snapshot(adopted)
    };

    const secondInFirstWindow = createPlayer();
    document.body.append(secondInFirstWindow);
    await secondInFirstWindow.prepare({ timeoutMs: 30_000 });
    const afterIndependentClaim = {
      main: snapshot(main),
      adopted: snapshot(adopted),
      secondInFirstWindow: snapshot(secondInFirstWindow)
    };

    await secondInFirstWindow.dispose().catch(() => undefined);
    await adopted.dispose().catch(() => undefined);
    secondInFirstWindow.remove();
    adopted.remove();
    frame.remove();
    return { beforeAdoption, afterAdoption, afterIndependentClaim };
  });

  const active = {
    readiness: "interactiveReady",
    mode: "animated",
    staticReason: null,
    localLease: 1,
    decoderState: "granted"
  };
  expect(result).toMatchObject({
    beforeAdoption: {
      main: { ...active, page: { participants: 2, active: 2, queued: 0 } },
      adopted: { ...active, page: { participants: 2, active: 2, queued: 0 } }
    },
    afterAdoption: {
      main: { ...active, page: { participants: 1, active: 1, queued: 0 } },
      adopted: { ...active, page: { participants: 1, active: 1, queued: 0 } }
    },
    afterIndependentClaim: {
      main: { ...active, page: { participants: 2, active: 2, queued: 0 } },
      secondInFirstWindow: {
        ...active,
        page: { participants: 2, active: 2, queued: 0 }
      },
      adopted: { ...active, page: { participants: 1, active: 1, queued: 0 } }
    }
  });
});

test("same-task shadow-root reparent rebinds inputs without retiring the participant", async ({
  page
}) => {
  await loadDefinition(page, "shadow-reparent", true);

  const result = await page.evaluate(async () => {
    type ListenerCounts = { added: string[]; removed: string[] };
    const spyOnListeners = (target: HTMLElement): ListenerCounts => {
      const counts: ListenerCounts = { added: [], removed: [] };
      const add = target.addEventListener;
      const remove = target.removeEventListener;
      target.addEventListener = function (
        this: HTMLElement,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void {
        counts.added.push(type);
        Reflect.apply(add, this, [type, listener, options]);
      } as HTMLElement["addEventListener"];
      target.removeEventListener = function (
        this: HTMLElement,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
      ): void {
        counts.removed.push(type);
        Reflect.apply(remove, this, [type, listener, options]);
      } as HTMLElement["removeEventListener"];
      return counts;
    };

    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly ready: Promise<void>;
        readonly player: AvalPlayerElement;
      };
    }).avalSourcePlayground;
    await api.ready;
    const player = api.player;

    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    firstHost.style.cssText = secondHost.style.cssText =
      "display:block;width:640px;height:360px";
    const firstRoot = firstHost.attachShadow({ mode: "open" });
    const secondRoot = secondHost.attachShadow({ mode: "open" });
    const firstTarget = document.createElement("div");
    const secondTarget = document.createElement("div");
    firstTarget.id = secondTarget.id = "interaction";
    firstRoot.append(firstTarget);
    secondRoot.append(secondTarget);
    document.body.append(firstHost, secondHost);

    const firstListeners = spyOnListeners(firstTarget);
    const secondListeners = spyOnListeners(secondTarget);
    firstRoot.append(player);
    player.setAttribute("interaction-for", "interaction");
    const before = player.getDiagnostics();

    secondRoot.append(player);
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = player.getDiagnostics();

    const snapshot = {
      firstListeners: {
        added: [...firstListeners.added],
        removed: [...firstListeners.removed]
      },
      secondListeners: {
        added: [...secondListeners.added],
        removed: [...secondListeners.removed]
      },
      before: {
        sourceGeneration: before.sourceGeneration,
        participants: before.runtime.pageParticipantCount,
        leases: before.runtime.activeLeaseCount,
        player: before.outstanding.player,
        codec: before.runtime.selectedCodec
      },
      after: {
        sourceGeneration: after.sourceGeneration,
        participants: after.runtime.pageParticipantCount,
        leases: after.runtime.activeLeaseCount,
        player: after.outstanding.player,
        codec: after.runtime.selectedCodec
      }
    };

    player.removeAttribute("interaction-for");
    document.body.append(player);
    firstHost.remove();
    secondHost.remove();
    return snapshot;
  });

  const inputTypes = ["pointerenter", "pointerleave", "focusin", "focusout", "click"];
  expect(result.firstListeners.added).toEqual(inputTypes);
  expect(result.firstListeners.removed).toEqual(inputTypes);
  expect(result.secondListeners.added).toEqual(inputTypes);
  expect(result.before.participants).toBeGreaterThan(0);
  expect(result.after).toEqual(result.before);
});

test("zero-ratio and unsupported intersection observers both remain hidden", async ({ page }) => {
  await loadDefinition(page, "intersection-hidden");

  const visibility = await page.evaluate(async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(window, "IntersectionObserver");
    let callback: IntersectionObserverCallback | null = null;

    class ControlledIntersectionObserver {
      public readonly root = null;
      public readonly rootMargin = "0px";
      public readonly thresholds = [0];
      public constructor(next: IntersectionObserverCallback) { callback = next; }
      public disconnect(): void {}
      public observe(): void {}
      public takeRecords(): IntersectionObserverEntry[] { return []; }
      public unobserve(): void {}
    }

    const restore = (): void => {
      if (ownDescriptor === undefined) delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
      else Object.defineProperty(window, "IntersectionObserver", ownDescriptor);
    };
    const positiveRect = new DOMRect(0, 0, 32, 32);

    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: ControlledIntersectionObserver
    });
    const zeroRatio = document.createElement("aval-player") as unknown as AvalPlayerElement;
    zeroRatio.getBoundingClientRect = () => positiveRect;
    document.body.append(zeroRatio);
    const publishIntersection = callback as unknown as IntersectionObserverCallback;
    publishIntersection([{
      isIntersecting: true,
      intersectionRatio: 0,
      target: zeroRatio
    } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    const zeroRatioVisibility = zeroRatio.getDiagnostics().visibility;
    await zeroRatio.dispose().catch(() => undefined);
    zeroRatio.remove();

    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: undefined
    });
    const unsupported = document.createElement("aval-player") as unknown as AvalPlayerElement;
    unsupported.getBoundingClientRect = () => positiveRect;
    document.body.append(unsupported);
    const unsupportedVisibility = unsupported.getDiagnostics().visibility;
    await unsupported.dispose().catch(() => undefined);
    unsupported.remove();
    restore();

    return {
      zeroRatio: zeroRatioVisibility,
      unsupported: unsupportedVisibility
    };
  });

  expect(visibility).toMatchObject({
    zeroRatio: {
      observerSupported: true,
      positiveBox: true,
      intersecting: false,
      effectivelyVisible: false
    },
    unsupported: {
      observerSupported: false,
      positiveBox: true,
      intersecting: false,
      effectivelyVisible: false
    }
  });
});

async function loadDefinition(
  page: Page,
  label: string,
  waitForPlayer = false
): Promise<void> {
  const session = `${label}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  await page.goto(`/?session=${encodeURIComponent(session)}&integrity=0`);
  await page.evaluate(async (ready) => {
    await customElements.whenDefined("aval-player");
    if (ready) {
      await (window as unknown as {
        avalSourcePlayground: { readonly ready: Promise<void> };
      }).avalSourcePlayground.ready;
    }
  }, waitForPlayer);
}

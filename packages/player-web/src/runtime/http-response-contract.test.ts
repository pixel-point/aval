import { describe, expect, it } from "vitest";

import {
  parseCanonicalContentLength,
  readRuntimeHeader,
  validateIdentityContentEncoding,
  validateRuntimeHttpResponse,
  type RuntimeHeadersView,
  type RuntimeHttpResponseContractInput
} from "./http-response-contract.js";

describe("common HTTP response contract", () => {
  it.each([
    [null, null],
    ["0", 0],
    ["64", 64],
    ["\t9007199254740991 ", Number.MAX_SAFE_INTEGER]
  ])("parses absent or one canonical Content-Length", (value, expected) => {
    expect(parseCanonicalContentLength(value)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "+1",
    "-1",
    "01",
    "1.0",
    "1 0",
    "1, 1",
    "9007199254740992",
    "1\n"
  ])("rejects malformed Content-Length %j", (value) => {
    expect(() => parseCanonicalContentLength(value)).toThrow(RangeError);
  });

  it("accepts only absent or one identity content coding", () => {
    expect(validateIdentityContentEncoding(null)).toBeNull();
    expect(validateIdentityContentEncoding(" identity ")).toBe("identity");
    expect(validateIdentityContentEncoding("IDENTITY")).toBe("identity");

    for (const value of [
      "",
      " ",
      "gzip",
      "identity, gzip",
      "identity,identity",
      "id entity",
      "identity\n"
    ]) {
      expect(() => validateIdentityContentEncoding(value)).toThrow(RangeError);
    }
  });

  it("validates exact status, final URL, body, encoding, length, and cap", () => {
    const headers = createHeaders({
      "content-encoding": "Identity",
      "content-length": "64"
    });
    const result = validateRuntimeHttpResponse({
      status: 206,
      expectedStatus: 206,
      responseType: "cors",
      finalUrl: "https://cdn.example.test/assets/motion.rma",
      pinnedFinalUrl: "https://cdn.example.test/assets/motion.rma",
      bodyAvailable: true,
      headers,
      expectedBodyBytes: 64,
      maximumBodyBytes: 64
    });

    expect(result).toEqual({
      status: 206,
      finalUrl: "https://cdn.example.test/assets/motion.rma",
      contentLength: 64
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("allows a range request to branch on bounded 200 or exact 206", () => {
    for (const status of [200, 206] as const) {
      expect(
        validateRuntimeHttpResponse({
          status,
          expectedStatus: "range-or-full",
          responseType: "basic",
          finalUrl: "http://127.0.0.1/asset.rma",
          bodyAvailable: true,
          headers: createHeaders({}),
          maximumBodyBytes: 1024
        }).status
      ).toBe(status);
    }
  });

  it.each([
    { status: 0, responseType: "opaque" },
    { status: 200, expectedStatus: 206 },
    { status: 206, expectedStatus: 200 },
    { status: 404 },
    { finalUrl: "" },
    { finalUrl: "data:text/plain,bytes" },
    { pinnedFinalUrl: "https://other.example.test/asset.rma" },
    { bodyAvailable: false },
    { bodyAvailable: 1 as unknown as boolean },
    { maximumBodyBytes: 0 },
    { expectedBodyBytes: 65 },
    { headers: createHeaders({ "content-length": "65" }) },
    { headers: createHeaders({ "content-encoding": "gzip" }) }
  ] satisfies readonly Partial<RuntimeHttpResponseContractInput>[]) (
    "rejects invalid common response field %#",
    (override) => {
    expect(() =>
      validateRuntimeHttpResponse({
        status: 206,
        expectedStatus: 206,
        responseType: "cors",
        finalUrl: "https://cdn.example.test/asset.rma",
        pinnedFinalUrl: "https://cdn.example.test/asset.rma",
        bodyAvailable: true,
        headers: createHeaders({ "content-length": "64" }),
        expectedBodyBytes: 64,
        maximumBodyBytes: 64,
        ...override
      })
    ).toThrow(RangeError);
    }
  );

  it("rejects a noncanonical final URL before any identity is pinned", () => {
    expect(() =>
      validateRuntimeHttpResponse({
        status: 200,
        expectedStatus: 200,
        responseType: "basic",
        finalUrl: " https://cdn.example.test/asset.rma",
        bodyAvailable: true,
        headers: createHeaders({}),
        maximumBodyBytes: 64
      })
    ).toThrow(RangeError);
  });

  it("reads each requested header once and normalizes hostile access failures", () => {
    const calls: string[] = [];
    const headers: RuntimeHeadersView = {
      get(name) {
        calls.push(name);
        return null;
      }
    };

    expect(readRuntimeHeader(headers, "ETag")).toBeNull();
    expect(calls).toEqual(["ETag"]);

    const hostile = Object.create(null) as RuntimeHeadersView;
    Object.defineProperty(hostile, "get", {
      get(): never {
        throw new Error("secret response header");
      }
    });
    expect(() => readRuntimeHeader(hostile, "ETag")).toThrow(
      "response header access failed"
    );

    const wrongType = {
      get: () => 12
    } as unknown as RuntimeHeadersView;
    expect(() => readRuntimeHeader(wrongType, "ETag")).toThrow(
      "response header value is invalid"
    );
  });

  it("does not leak a hostile response-contract accessor failure", () => {
    const hostile = Object.create(null) as RuntimeHttpResponseContractInput;
    Object.defineProperty(hostile, "status", {
      get(): never {
        throw new Error("secret response metadata");
      }
    });

    expect(() => validateRuntimeHttpResponse(hostile)).toThrow(
      "response contract access failed"
    );
  });
});

function createHeaders(values: Readonly<Record<string, string>>): RuntimeHeadersView {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    }
  };
}

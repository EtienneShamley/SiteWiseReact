// src/lib/apiAuth.test.js
//
// The browser's one identity-attaching request boundary (src/lib/apiAuth.js):
// the Bearer header, the no-session short circuit, the single forced-refresh
// retry on an expired token, and the promise that nothing loops and nothing
// is stored.
import {
  API_AUTH_OUTCOME,
  ApiAuthError,
  __resetApiAuthForTests,
  apiAuthOutcomeForResponse,
  authorizedFetch,
  hasApiTokenProvider,
  setApiTokenProvider,
} from "./apiAuth";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  clone() {
    return response(status, body);
  },
  json: async () => body,
});

afterEach(() => {
  __resetApiAuthForTests();
});

describe("authorizedFetch — attaching identity", () => {
  test("sends Authorization: Bearer <token> from the injected provider, keeping the caller's headers", async () => {
    const fetchImpl = jest.fn(async () => response(200, { ok: 1 }));
    const getToken = jest.fn(async () => "id-token-1");
    const res = await authorizedFetch("/api/x", { method: "POST", headers: { "Content-Type": "application/json" } }, { fetchImpl, getToken });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/x");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer id-token-1" });
    expect(getToken).toHaveBeenCalledWith(false);
  });

  test("uses the registered provider when none is injected", async () => {
    setApiTokenProvider(async () => "registered-token");
    expect(hasApiTokenProvider()).toBe(true);
    const fetchImpl = jest.fn(async () => response(200, {}));
    await authorizedFetch("/api/x", {}, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer registered-token");
  });

  test("the token is read per request and never stored anywhere", async () => {
    let n = 0;
    const getToken = async () => `token-${(n += 1)}`;
    const fetchImpl = jest.fn(async () => response(200, {}));
    await authorizedFetch("/api/x", {}, { fetchImpl, getToken });
    await authorizedFetch("/api/x", {}, { fetchImpl, getToken });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer token-1");
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer token-2");
    expect(Object.keys(window.localStorage).some((k) => /token/i.test(k))).toBe(false);
    expect(Object.keys(window.sessionStorage).some((k) => /token/i.test(k))).toBe(false);
  });
});

describe("authorizedFetch — no session", () => {
  test("no provider registered → ApiAuthError(unauthenticated) without any network request", async () => {
    const fetchImpl = jest.fn();
    await expect(authorizedFetch("/api/x", {}, { fetchImpl })).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a provider that reports no session (null) → the same, without a request", async () => {
    const fetchImpl = jest.fn();
    let caught = null;
    try {
      await authorizedFetch("/api/x", {}, { fetchImpl, getToken: async () => null });
    } catch (e) {
      caught = e;
    }
    expect(caught.outcome).toBe(API_AUTH_OUTCOME.UNAUTHENTICATED);
    expect(caught.message).toBe("Sign in required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("clearing the provider signs the boundary out", async () => {
    setApiTokenProvider(async () => "t");
    setApiTokenProvider(null);
    expect(hasApiTokenProvider()).toBe(false);
    await expect(authorizedFetch("/api/x", {}, { fetchImpl: jest.fn() })).rejects.toBeInstanceOf(ApiAuthError);
  });
});

describe("authorizedFetch — expired token", () => {
  test("401 auth_token_expired → exactly one forced refresh and one retry", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(401, { code: "auth_token_expired" }))
      .mockResolvedValueOnce(response(200, { refined: "ok" }));
    const getToken = jest.fn(async (force) => (force ? "fresh-token" : "stale-token"));
    const res = await authorizedFetch("/api/refine", { method: "POST" }, { fetchImpl, getToken });
    expect(res.status).toBe(200);
    expect(getToken.mock.calls).toEqual([[false], [true]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-token");
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  test("a second expiry is returned as-is — no loop", async () => {
    const fetchImpl = jest.fn(async () => response(401, { code: "auth_token_expired" }));
    const getToken = jest.fn(async () => "t");
    const res = await authorizedFetch("/api/refine", {}, { fetchImpl, getToken });
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  test("any OTHER 401 (invalid, required) is returned without a retry", async () => {
    for (const code of ["auth_invalid", "auth_required", undefined]) {
      const fetchImpl = jest.fn(async () => response(401, code ? { code } : {}));
      const getToken = jest.fn(async () => "t");
      const res = await authorizedFetch("/api/refine", {}, { fetchImpl, getToken });
      expect(res.status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledTimes(1);
    }
  });

  test("if the forced refresh finds no session, the caller learns it is signed out (no retry)", async () => {
    const fetchImpl = jest.fn(async () => response(401, { code: "auth_token_expired" }));
    const getToken = jest.fn(async (force) => (force ? null : "stale"));
    await expect(authorizedFetch("/api/refine", {}, { fetchImpl, getToken })).rejects.toMatchObject({
      outcome: API_AUTH_OUTCOME.UNAUTHENTICATED,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("403 and 5xx pass straight through; a network failure propagates as thrown", async () => {
    const getToken = async () => "t";
    expect((await authorizedFetch("/x", {}, { fetchImpl: async () => response(403, { code: "email_not_verified" }), getToken })).status).toBe(403);
    expect((await authorizedFetch("/x", {}, { fetchImpl: async () => response(503, {}), getToken })).status).toBe(503);
    await expect(
      authorizedFetch("/x", {}, {
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch");
        },
        getToken,
      })
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("apiAuthOutcomeForResponse", () => {
  test("401 → unauthenticated; 403 email_not_verified → email_not_verified; anything else → null", async () => {
    expect(await apiAuthOutcomeForResponse(response(401, { code: "auth_invalid" }))).toBe(API_AUTH_OUTCOME.UNAUTHENTICATED);
    expect(await apiAuthOutcomeForResponse(response(403, { code: "email_not_verified" }))).toBe(API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED);
    expect(await apiAuthOutcomeForResponse(response(403, { code: "origin_not_allowed" }))).toBeNull();
    expect(await apiAuthOutcomeForResponse(response(200, {}))).toBeNull();
    expect(await apiAuthOutcomeForResponse(response(502, {}))).toBeNull();
    expect(await apiAuthOutcomeForResponse(null)).toBeNull();
  });

  test("ApiAuthError carries the fixed transport messages", () => {
    expect(new ApiAuthError(API_AUTH_OUTCOME.UNAUTHENTICATED).message).toBe("Sign in required");
    expect(new ApiAuthError(API_AUTH_OUTCOME.EMAIL_NOT_VERIFIED).message).toBe("Email verification required");
  });
});

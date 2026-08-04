// Unit tests for the object-URL lifecycle manager (src/lib/blobPreviewUrl.js).
// create/revoke are injected fakes throughout — jsdom does not implement
// URL.createObjectURL, and this module is exactly what makes that untestable
// browser API unnecessary to exercise the lifecycle rules directly.
import { createBlobPreviewUrlManager } from "./blobPreviewUrl";

function fakeUrls(prefix = "fake") {
  let n = 0;
  const created = [];
  const revoked = [];
  return {
    createObjectURL: (blob) => {
      n += 1;
      const url = `blob:${prefix}-${n}`;
      created.push({ url, blob });
      return url;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    created,
    revoked,
  };
}

describe("creating one URL per Blob", () => {
  test("set(blob) creates exactly one URL and returns it", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);
    const blob = { id: "a" };

    const url = manager.set(blob);

    expect(fake.created).toEqual([{ url: "blob:fake-1", blob }]);
    expect(url).toBe("blob:fake-1");
    expect(manager.url).toBe("blob:fake-1");
  });

  test("two managers never share state", () => {
    const fakeA = fakeUrls("a");
    const fakeB = fakeUrls("b");
    const a = createBlobPreviewUrlManager(fakeA);
    const b = createBlobPreviewUrlManager(fakeB);

    a.set({ id: "a" });
    b.set({ id: "b" });

    expect(fakeA.created).toHaveLength(1);
    expect(fakeB.created).toHaveLength(1);
    expect(a.url).not.toBe(b.url);
  });
});

describe("revoking the previous URL on replacement", () => {
  test("set(blob2) revokes the URL set(blob1) created, before creating the new one", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);

    const first = manager.set({ id: 1 });
    expect(fake.revoked).toEqual([]);

    const second = manager.set({ id: 2 });

    expect(fake.revoked).toEqual([first]);
    expect(second).not.toBe(first);
    expect(manager.url).toBe(second);
  });

  test("there is never more than one live URL from one manager", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);

    manager.set({ id: 1 });
    manager.set({ id: 2 });
    manager.set({ id: 3 });

    // Three created, two revoked (all but the current one).
    expect(fake.created).toHaveLength(3);
    expect(fake.revoked).toHaveLength(2);
    expect(fake.revoked).not.toContain(manager.url);
  });

  test("set(null) / set(undefined) clears without creating a URL", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);

    const first = manager.set({ id: 1 });
    const result = manager.set(null);

    expect(result).toBeNull();
    expect(manager.url).toBeNull();
    expect(fake.revoked).toEqual([first]);
    expect(fake.created).toHaveLength(1); // no second create for the null blob
  });
});

describe("clear()", () => {
  test("revokes the active URL and forgets it", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);
    const url = manager.set({ id: 1 });

    manager.clear();

    expect(fake.revoked).toEqual([url]);
    expect(manager.url).toBeNull();
  });

  test("calling clear() twice only revokes once — safe for close-then-unmount", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);
    manager.set({ id: 1 });

    manager.clear();
    manager.clear();

    expect(fake.revoked).toHaveLength(1);
  });

  test("clear() with nothing set is a safe no-op", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);

    manager.clear();

    expect(fake.revoked).toEqual([]);
    expect(manager.url).toBeNull();
  });

  test("set() after clear() creates a fresh URL normally", () => {
    const fake = fakeUrls();
    const manager = createBlobPreviewUrlManager(fake);
    manager.set({ id: 1 });
    manager.clear();

    const url = manager.set({ id: 2 });

    expect(url).toBe("blob:fake-2");
    expect(manager.url).toBe("blob:fake-2");
  });
});

describe("default create/revoke fall back to the global URL object", () => {
  test("uses global URL.createObjectURL / revokeObjectURL when none are injected", () => {
    const originalCreate = global.URL.createObjectURL;
    const originalRevoke = global.URL.revokeObjectURL;
    const create = jest.fn(() => "blob:global-1");
    const revoke = jest.fn();
    global.URL.createObjectURL = create;
    global.URL.revokeObjectURL = revoke;

    try {
      const manager = createBlobPreviewUrlManager();
      const blob = { id: 1 };
      const url = manager.set(blob);
      expect(create).toHaveBeenCalledWith(blob);
      expect(url).toBe("blob:global-1");

      manager.clear();
      expect(revoke).toHaveBeenCalledWith("blob:global-1");
    } finally {
      global.URL.createObjectURL = originalCreate;
      global.URL.revokeObjectURL = originalRevoke;
    }
  });
});

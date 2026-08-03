// src/lib/html2pdfExportJob.test.js
//
// Ownership-safe cleanup of an abandoned html2pdf overlay.
//
// The overlay is `position: fixed; inset: 0; z-index: 1000` with no
// `pointer-events: none`, and html2pdf removes it only on the SUCCESS path. If
// a capture throws, it stays and swallows every click in the application.
//
// The dangerous fix is removing `.html2pdf__overlay` by class, which would tear
// down a CONCURRENT export. These tests pin the ownership rule.

import {
  EXPORT_JOB_ATTR,
  createExportJobId,
  markExportJob,
  releaseExportJob,
} from "./html2pdfExportJob";

// What html2pdf itself does: clone the source container into a new overlay and
// attach it to document.body.
function mountOverlayFor(container) {
  const overlay = document.createElement("div");
  overlay.className = "html2pdf__overlay";
  const inner = document.createElement("div");
  inner.className = "html2pdf__container";
  inner.appendChild(container.cloneNode(true));
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  return overlay;
}

function markedContainer(jobId) {
  const container = document.createElement("div");
  container.innerHTML = "<p>document</p>";
  markExportJob(container, jobId);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("job identity", () => {
  test("ids are unique and attribute-safe", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createExportJobId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^nw-pdf-[a-zA-Z0-9-]+$/);
  });

  test("the stamp travels into html2pdf's clone", () => {
    const jobId = createExportJobId();
    const overlay = mountOverlayFor(markedContainer(jobId));
    expect(
      overlay.querySelector(`[${EXPORT_JOB_ATTR}]`).getAttribute(EXPORT_JOB_ATTR)
    ).toBe(jobId);
  });

  test("a hostile id cannot reach the DOM as markup or as a selector", () => {
    const container = document.createElement("div");
    const id = markExportJob(container, '"] , * , [x="');
    expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(container.getAttribute(EXPORT_JOB_ATTR)).toBe(id);
    // Releasing must not throw and must not match anything by accident.
    expect(() => releaseExportJob('"] , * , [x="')).not.toThrow();
  });
});

describe("release", () => {
  test("removes the overlay this job abandoned", () => {
    const jobId = createExportJobId();
    mountOverlayFor(markedContainer(jobId));
    expect(document.querySelectorAll(".html2pdf__overlay")).toHaveLength(1);

    expect(releaseExportJob(jobId)).toBe(true);
    expect(document.querySelectorAll(".html2pdf__overlay")).toHaveLength(0);
  });

  test("NEVER removes another concurrent export's overlay", () => {
    const mine = createExportJobId();
    const theirs = createExportJobId();
    mountOverlayFor(markedContainer(mine));
    const other = mountOverlayFor(markedContainer(theirs));

    expect(releaseExportJob(mine)).toBe(true);
    const left = document.querySelectorAll(".html2pdf__overlay");
    expect(left).toHaveLength(1);
    expect(left[0]).toBe(other);

    expect(releaseExportJob(theirs)).toBe(true);
    expect(document.querySelectorAll(".html2pdf__overlay")).toHaveLength(0);
  });

  test("an unmarked overlay is left alone entirely", () => {
    const overlay = document.createElement("div");
    overlay.className = "html2pdf__overlay";
    document.body.appendChild(overlay);

    expect(releaseExportJob(createExportJobId())).toBe(false);
    expect(document.body.contains(overlay)).toBe(true);
  });

  test("the success path is a safe no-op — html2pdf already cleaned up", () => {
    const jobId = createExportJobId();
    mountOverlayFor(markedContainer(jobId)).remove();
    expect(releaseExportJob(jobId)).toBe(false);
    expect(document.body.children).toHaveLength(0);
  });

  test("releasing twice, or with no id, changes nothing and does not throw", () => {
    const jobId = createExportJobId();
    mountOverlayFor(markedContainer(jobId));
    expect(releaseExportJob(jobId)).toBe(true);
    expect(releaseExportJob(jobId)).toBe(false);
    expect(releaseExportJob(null)).toBe(false);
    expect(releaseExportJob("")).toBe(false);
  });

  test("the application is left clickable and a later export still mounts", () => {
    const jobId = createExportJobId();
    mountOverlayFor(markedContainer(jobId));
    releaseExportJob(jobId);
    expect(document.querySelector(".html2pdf__overlay")).toBeNull();

    const next = createExportJobId();
    mountOverlayFor(markedContainer(next));
    expect(document.querySelectorAll(".html2pdf__overlay")).toHaveLength(1);
    expect(releaseExportJob(next)).toBe(true);
    expect(document.body.children).toHaveLength(0);
  });
});

export async function downloadZip(files, zipName = "sitewise-export.zip") {
  // files: Array<{ path: string, blob: Blob }>
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  for (const f of files) {
    zip.file(f.path, f.blob);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

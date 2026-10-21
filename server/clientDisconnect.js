// server/clientDisconnect.js
//
// An AbortSignal that fires when the BROWSER stops waiting for this response.
//
// The provider-backed routes used to carry on after the client had gone — its
// deadline passed, the user cancelled, the tab closed — so a request nobody
// would ever read still ran to the end, and Refine could even start its
// corrective second attempt for it. That is a paid request spent on nothing.
// Handing this signal to the provider SDK (`{ signal }` in its request
// options) stops the provider call instead; the route then writes nothing,
// since there is nobody to write to.
//
// `res` "close" fires both when the connection drops AND after a normal,
// complete response; only the first is a disconnect, which is what
// `writableFinished` tells apart. A test double without event support gets a
// signal that simply never fires.

function clientDisconnectSignal(res) {
  const controller = new AbortController();
  if (res && typeof res.on === "function") {
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
  }
  return controller.signal;
}

module.exports = { clientDisconnectSignal };

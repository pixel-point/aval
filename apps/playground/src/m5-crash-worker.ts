self.addEventListener("message", () => {
  throw new Error("intentional M5 conformance worker crash");
});

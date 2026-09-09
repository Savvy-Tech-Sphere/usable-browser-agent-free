export const SCREENSHOT_BLOCKED_MESSAGE = "screenshot blocked: a credential is present on the page.";

function screenshotBlockedError() {
  return new Error(SCREENSHOT_BLOCKED_MESSAGE);
}

export async function captureScreenshot({ call, brokerInProgress = false, strictSecrets = false } = {}) {
  if (brokerInProgress) throw screenshotBlockedError();

  const result = await call("screenshot", { strictSecrets });
  if (result?.blocked || result?.credentialPresent || result?.credentialState?.credentialPresent) {
    throw screenshotBlockedError();
  }
  if (!result?.dataUrl) throw new Error("screenshot command did not return image data.");
  return result.dataUrl;
}

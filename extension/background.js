chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// v0.6.2 intentionally does not create a Native Messaging host or receive Agent commands.
// v0.7 may call this after it has independently verified a write completion and selected a tab.
// Keeping the forwarding boundary here prevents a future transport from bypassing the content-script
// base-hash validation implemented by the artifact-update-ready consumer.
async function forwardArtifactUpdateToTab(tabId, completion) {
  return chrome.tabs.sendMessage(tabId, completion);
}

"use strict";
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "capture-question" || tab?.id == null || tab?.windowId == null) return;
  // Open while the keyboard command's user gesture is still active.
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const request = { id: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, createdAt: Date.now() };
  opening.then(() => chrome.storage.session.set({ [`captureShortcut:${tab.windowId}`]: request })).catch(console.error);
});

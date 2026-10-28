// Background Service Worker for Manifest V3
chrome.runtime.onInstalled.addListener(() => {
  // Configures the side panel to open automatically when user clicks the extension action icon
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.error('SidePanel config error:', error));
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open && tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

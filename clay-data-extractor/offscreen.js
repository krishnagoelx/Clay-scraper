// =============================================================
// offscreen.js — Handles clipboard operations
// Runs in an offscreen document context (has DOM access)
// =============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'OFFSCREEN_COPY') {
    copyToClipboard(message.text);
    // Don't sendResponse here — we use a separate message
    return false;
  }
});

async function copyToClipboard(text) {
  try {
    // Try modern Clipboard API first
    await navigator.clipboard.writeText(text);
    chrome.runtime.sendMessage({ action: 'OFFSCREEN_COPY_RESULT', success: true });
  } catch (err) {
    // Fallback: use textarea + execCommand
    try {
      const textarea = document.getElementById('clipboard-area');
      textarea.value = text;
      textarea.select();
      document.execCommand('copy');
      chrome.runtime.sendMessage({ action: 'OFFSCREEN_COPY_RESULT', success: true });
    } catch (fallbackErr) {
      chrome.runtime.sendMessage({
        action: 'OFFSCREEN_COPY_RESULT',
        success: false,
        error: fallbackErr.message,
      });
    }
  }
}

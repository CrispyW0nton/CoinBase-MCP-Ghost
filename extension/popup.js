const status = document.querySelector("#status");
const downloadDirect = document.querySelector("#downloads");

document.querySelector("#collect").addEventListener("click", () => run("collectCurrent"));
document.querySelector("#archive").addEventListener("click", () => run("archiveLinks"));

async function run(action) {
  status.textContent = "Working...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let response;
  try {
    response = await send(tab.id, action);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    response = await send(tab.id, action);
  }
  status.textContent = response?.message || JSON.stringify(response, null, 2);
}

function send(tabId, action) {
  return chrome.tabs.sendMessage(tabId, {
    action,
    downloadDirect: downloadDirect.checked
  });
}

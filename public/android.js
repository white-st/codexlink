const release = document.getElementById('release');
const hash = document.getElementById('hash');
fetch('/downloads/release.json', { credentials: 'omit' }).then(async response => {
  if (!response.ok) throw new Error();
  const data = await response.json();
  release.textContent = `测试版 ${data.version} · ${(data.size / 1024 / 1024).toFixed(2)} MB · 安卓 ${data.minAndroid} 及以上`;
  hash.textContent = `SHA-256：${data.sha256}`;
}).catch(() => { hash.textContent = '安装包信息暂时无法读取，请稍后刷新。'; });

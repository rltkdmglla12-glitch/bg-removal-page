// rocket-register 확장프로그램의 "이미지 조정" 팝업이 iframe으로 이 페이지를 불러와 쓰는 연결 다리.
// app.js는 손대지 않고, 그 위에서 동작하는 별도 스크립트로만 연동한다(업스트림 업데이트에 영향 안 받게).
(function () {
  function loadFile(file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const dz = document.getElementById('dropzone');
    if (!dz) return;
    const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    dz.dispatchEvent(evt);
  }

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'rr-load-image') return;
    try {
      const blob = await (await fetch(msg.dataUrl)).blob();
      loadFile(new File([blob], 'image.png', { type: blob.type || 'image/png' }));
    } catch (e) {}
  });

  const btn = document.getElementById('btn-download');
  if (btn) {
    btn.addEventListener('click', () => {
      const canvas = document.getElementById('canvas-result');
      if (!canvas || canvas.hidden) return;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const fr = new FileReader();
        fr.onload = () => {
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'rr-erase-result', dataUrl: String(fr.result || '') }, '*');
          }
        };
        fr.readAsDataURL(blob);
      }, 'image/png');
    });
  }

  if (window.parent !== window) {
    window.parent.postMessage({ type: 'rr-erase-ready' }, '*');
  }
})();

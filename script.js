/* ============================================================
   ClipFetch — script.js
   All logic runs 100% in the browser. No URLs are transmitted
   or stored anywhere. Honest status reporting only — we never
   claim a download succeeded unless it actually did.
   ============================================================ */

(function () {
  'use strict';

  /* ------------------------- Config ------------------------- */

  // Safety cap for remote downloads handled via fetch() in the browser.
  // Anything bigger is offered via "Open in new tab" instead.
  var MAX_FETCH_BYTES = 512 * 1024 * 1024;   // 512 MB
  var MAX_WARN_BYTES  = 2 * 1024 * 1024 * 1024; // 2 GB

  var VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv', '3gp'];
  var VIDEO_MIME_PARTS = ['video/', 'application/ogg', 'video'];

  var YOUTUBE_HOSTS = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtu.be', 'www.youtu.be'
  ];

  /* ----------------------- DOM refs ------------------------- */

  var form        = document.getElementById('check-form');
  var urlInput    = document.getElementById('url-input');
  var checkBtn    = document.getElementById('check-btn');
  var statusArea  = document.getElementById('status-area');

  var resultCard  = document.getElementById('result-card');
  var resultTitle = document.getElementById('result-title');
  var resultBadge = document.getElementById('result-badge');
  var resultName  = document.getElementById('result-name');
  var resultType  = document.getElementById('result-type');
  var resultSize  = document.getElementById('result-size');
  var downloadBtn = document.getElementById('download-btn');
  var openTabBtn  = document.getElementById('open-tab-btn');
  var resultNote  = document.getElementById('result-note');

  var youtubeCard = document.getElementById('youtube-card');
  var youtubeBtn  = document.getElementById('youtube-open-btn');

  var fileInput   = document.getElementById('file-input');
  var fileCard    = document.getElementById('file-card');
  var fileName    = document.getElementById('file-name');
  var fileType    = document.getElementById('file-type');
  var fileSize    = document.getElementById('file-size');
  var saveCopyBtn = document.getElementById('save-copy-btn');
  var fileNote    = document.getElementById('file-note');

  var selectedFile  = null;   // File chosen by the user (local)
  var currentUrl    = null;   // URL that passed validation

  /* --------------------- Small helpers ---------------------- */

  function showStatus(message, kind) {
    statusArea.innerHTML = '';
    if (!message) return;
    var div = document.createElement('div');
    div.className = 'status ' + (kind || 'info');
    div.textContent = message;
    statusArea.appendChild(div);
  }

  function hide(el) { el.hidden = true; }
  function show(el) { el.hidden = false; }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return 'Unknown';
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    var value = bytes / Math.pow(1024, i);
    return (i === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)) + ' ' + units[i];
  }

  function getExtension(pathname) {
    var last = pathname.split('/').pop() || '';
    var dot = last.lastIndexOf('.');
    if (dot <= 0) return '';
    return last.slice(dot + 1).toLowerCase();
  }

  function filenameFromUrl(url) {
    var last = url.pathname.split('/').pop();
    try { last = decodeURIComponent(last); } catch (e) { /* keep raw */ }
    return last || 'video-file';
  }

  function filenameFromDisposition(header) {
    if (!header) return null;
    // Prefer RFC 5987 filename*
    var star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try { return decodeURIComponent(star[1].trim().replace(/"/g, '')); } catch (e) { /* fall through */ }
    }
    var plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain) return plain[1].trim();
    return null;
  }

  function isYoutubeUrl(url) {
    var host = url.hostname.toLowerCase();
    return YOUTUBE_HOSTS.indexOf(host) !== -1 ||
           host.endsWith('.youtube.com');
  }

  function looksLikeVideo(contentType, url) {
    if (contentType) {
      var ct = contentType.split(';')[0].trim().toLowerCase();
      for (var i = 0; i < VIDEO_MIME_PARTS.length; i++) {
        if (ct.indexOf(VIDEO_MIME_PARTS[i]) === 0) return true;
      }
    }
    return VIDEO_EXTENSIONS.indexOf(getExtension(url.pathname)) !== -1;
  }

  function setBusy(busy, label) {
    checkBtn.disabled = busy;
    urlInput.disabled = busy;
    checkBtn.textContent = busy ? 'Checking…' : (label || 'Check Video');
  }

  /* --------------------- URL validation --------------------- */

  function validateUrl(raw) {
    var value = (raw || '').trim();
    if (!value) {
      return { ok: false, error: 'Please paste a video file URL first.' };
    }
    var url;
    try {
      url = new URL(value);
    } catch (e) {
      return { ok: false, error: 'That does not look like a valid URL. It should start with https:// and point directly to a video file.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'Unsupported protocol "' + url.protocol.replace(':', '') + '". Only http:// and https:// links are allowed, for your safety.' };
    }
    if (!url.hostname.includes('.')) {
      return { ok: false, error: 'That URL does not look complete — check the domain and try again.' };
    }
    return { ok: true, url: url };
  }

  /* ------------------- Remote file check -------------------- */

  function checkRemoteFile(url) {
    setBusy(true);
    showStatus('Checking the link — reading file name, type and size…', 'info');
    hide(resultCard);
    hide(youtubeCard);

    fetch(url.href, { method: 'HEAD', mode: 'cors' })
      .then(function (response) {
        // Some servers reject HEAD (405/501) but allow GET with Range.
        if (response.status === 405 || response.status === 501) {
          return fetch(url.href, {
            method: 'GET',
            mode: 'cors',
            headers: { 'Range': 'bytes=0-0' }
          });
        }
        return response;
      })
      .then(function (response) {
        if (!response.ok && response.status !== 206) {
          throw { kind: 'http', status: response.status };
        }

        var contentType  = response.headers.get('Content-Type');
        var contentLen   = response.headers.get('Content-Length');
        var disposition  = response.headers.get('Content-Disposition');
        var size = contentLen ? parseInt(contentLen, 10) : null;

        var isVideo = looksLikeVideo(contentType, url);
        var name = filenameFromDisposition(disposition) || filenameFromUrl(url);

        if (!isVideo) {
          setBusy(false);
          showStatus(
            'That link does not appear to be a video file ' +
            (contentType ? '(server says it is "' + contentType + '")' : '') +
            '. ClipFetch only works with direct links to video files, such as .mp4 or .webm.',
            'error'
          );
          return;
        }

        // Success — fill the result card
        currentUrl = url.href;
        resultTitle.textContent = 'Video file found';
        resultBadge.textContent = 'Direct file';
        resultName.textContent = name;
        resultType.textContent = contentType ? contentType.split(';')[0] : '.' + (getExtension(url.pathname) || 'unknown');
        resultSize.textContent = formatBytes(size);
        show(resultCard);
        setBusy(false);
        showStatus('The link is a valid video file. Review the details, then download if you are allowed to.', 'success');

        // Size-dependent download behaviour
        if (size !== null && size > MAX_WARN_BYTES) {
          downloadBtn.disabled = true;
          resultNote.textContent = "This file is larger than 2 GB. Browsers cannot reliably save files that big from a web page — use the 'Open in new tab' option and your browser's built-in save feature instead.";
        } else if (size !== null && size > MAX_FETCH_BYTES) {
          downloadBtn.disabled = true;
          resultNote.textContent = 'This file is large (' + formatBytes(size) + '), so in-page downloading is disabled to protect your device. Use "Open in new tab" and save from there.';
        } else {
          downloadBtn.disabled = false;
          resultNote.textContent = 'Only download this file if you own it or have permission to save it.';
        }
      })
      .catch(function (err) {
        setBusy(false);
        hide(resultCard);

        if (err && err.kind === 'http') {
          var msg = 'The server responded with error ' + err.status + '. ';
          if (err.status === 403 || err.status === 401) {
            msg += 'Access is forbidden — the file may require a login or permission ClipFetch will not bypass.';
          } else if (err.status === 404) {
            msg += 'The file was not found at this address. Check the link for typos.';
          } else {
            msg += 'The file may have moved, or the server refused the check.';
          }
          showStatus(msg, 'error');
          return;
        }

        // Network failure / CORS block — the honest answer
        var reason = (err && err.name === 'TypeError')
          ? 'Your browser could not read the file details — most likely the server blocks cross-origin checks (CORS), the link is dead, or you are offline.'
          : 'The link could not be checked: ' + ((err && err.message) || 'unknown network error') + '.';
        showStatus(
          reason + ' You can try "Open in new tab" to let your browser handle the file natively — but note we could not verify what it is.',
          'error'
        );
        // Still offer the tab fallback for authorized direct links
        currentUrl = url.href;
        resultTitle.textContent = 'Unverified link';
        resultBadge.textContent = 'Unknown';
        resultName.textContent = filenameFromUrl(url);
        resultType.textContent = 'Could not verify';
        resultSize.textContent = 'Could not verify';
        downloadBtn.disabled = true;
        resultNote.textContent = 'Download disabled because the file could not be verified. "Open in new tab" uses your browser directly.';
        show(resultCard);
      });
  }

  /* -------------------- Download actions -------------------- */

  function downloadRemoteFile() {
    if (!currentUrl || downloadBtn.disabled) return;

    downloadBtn.disabled = true;
    var original = downloadBtn.textContent;
    downloadBtn.textContent = 'Downloading…';
    showStatus('Downloading in your browser — keep this tab open…', 'info');

    fetch(currentUrl, { mode: 'cors' })
      .then(function (response) {
        if (!response.ok) throw new Error('Server returned status ' + response.status);
        return response.blob();
      })
      .then(function (blob) {
        if (!blob || blob.size === 0) throw new Error('The server sent an empty file.');
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = filenameFromUrl(new URL(currentUrl));
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the browser a moment before revoking
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 4000);
        showStatus('Download finished and handed to your browser. Check your Downloads folder.', 'success');
      })
      .catch(function (err) {
        showStatus(
          'Download failed: ' + err.message + '. This usually means the server blocks direct downloads (CORS). Use "Open in new tab" instead — your browser will handle it natively.',
          'error'
        );
      })
      .finally(function () {
        downloadBtn.disabled = false;
        downloadBtn.textContent = original;
      });
  }

  function openInNewTab() {
    if (!currentUrl) return;
    window.open(currentUrl, '_blank', 'noopener');
  }

  /* -------------------- YouTube handling -------------------- */

  function showYoutubeNotice(url) {
    setBusy(false);
    hide(resultCard);
    showStatus('', '');
    youtubeBtn.href = url.href;
    show(youtubeCard);
    youtubeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------------- Local files ----------------------- */

  function onFileSelected() {
    var file = fileInput.files && fileInput.files[0];
    hide(fileCard);
    fileNote.textContent = '';

    if (!file) return;

    // Guard: it should be a video file
    var isVideoType = file.type && file.type.indexOf('video/') === 0;
    var isVideoExt = VIDEO_EXTENSIONS.indexOf(getExtension({ pathname: '/' + file.name })) !== -1;
    if (!isVideoType && !isVideoExt) {
      showStatus('That does not look like a video file (' + (file.type || 'unknown type') + '). Choose a video such as .mp4 or .webm.', 'error');
      fileInput.value = '';
      return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileType.textContent = file.type || 'Video file';
    fileSize.textContent = formatBytes(file.size);
    saveCopyBtn.disabled = false;
    show(fileCard);
    showStatus('File ready. Nothing was uploaded — it stays on your device until you save it.', 'success');
  }

  function saveLocalCopy() {
    if (!selectedFile) return;
    saveCopyBtn.disabled = true;
    try {
      var objectUrl = URL.createObjectURL(selectedFile);
      var a = document.createElement('a');
      a.href = objectUrl;
      a.download = selectedFile.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 4000);
      fileNote.textContent = 'A copy was handed to your browser. On phones, check Downloads or Files; on desktop, check your Downloads folder.';
      showStatus('Copy saved.', 'success');
    } catch (err) {
      fileNote.textContent = '';
      showStatus('Could not save the file: ' + err.message, 'error');
    } finally {
      saveCopyBtn.disabled = false;
    }
  }

  /* ----------------------- Wire events ---------------------- */

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    hide(youtubeCard);
    hide(resultCard);

    var check = validateUrl(urlInput.value);
    if (!check.ok) {
      showStatus(check.error, 'error');
      return;
    }
    if (isYoutubeUrl(check.url)) {
      showYoutubeNotice(check.url);
      return;
    }
    checkRemoteFile(check.url);
  });

  downloadBtn.addEventListener('click', downloadRemoteFile);
  openTabBtn.addEventListener('click', openInNewTab);
  fileInput.addEventListener('change', onFileSelected);
  saveCopyBtn.addEventListener('click', saveLocalCopy);

  // Footer year
  document.getElementById('year').textContent = new Date().getFullYear();
})();

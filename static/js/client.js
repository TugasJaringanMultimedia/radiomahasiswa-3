document.addEventListener("DOMContentLoaded", () => {
  const socket = io();
  const livePlayer = document.getElementById("livePlayer");
  const liveStatus = document.getElementById("live-status");
  const liveTitle = document.getElementById("live-title");
  const searchBox = document.getElementById("searchBox");
  const sortOptions = document.getElementById("sortOptions");
  const archiveList = document.getElementById("archive-list");

  let mediaSource;
  let sourceBuffer;
  let audioQueue = [];
  let isLiveBroadcastActive = false;
  let hasUserInteracted = false;
  let receivedInitialHeader = false;
  let isPlayerReadyForPlay = false; // BARU: Flag untuk menunjukkan kapan player siap untuk play()

  // Fungsi pembantu untuk mencoba memutar audio
  function attemptPlayAudio() {
    console.log("Mencoba play audio. State:", {
      isLiveBroadcastActive,
      hasUserInteracted,
      isPlayerReadyForPlay,
      paused: livePlayer.paused,
      muted: livePlayer.muted,
    });

    if (
      isLiveBroadcastActive &&
      hasUserInteracted &&
      isPlayerReadyForPlay &&
      livePlayer.paused
    ) {
      livePlayer.muted = true; // Coba mute dulu
      livePlayer
        .play()
        .then(() => {
          livePlayer.muted = false; // Unmute jika berhasil
          console.log("Live player play() berhasil.");
          const instructionSpan = document.getElementById(
            "autoplay-instruction"
          );
          if (instructionSpan) instructionSpan.remove();
        })
        .catch((e) => {
          console.warn("Live player play() dicegah atau gagal:", e);
          if (!document.getElementById("autoplay-instruction")) {
            liveStatus.innerHTML +=
              "<br><span id='autoplay-instruction' style='color: orange;'>Klik di mana saja pada halaman untuk memutar siaran.</span>";
          }
        });
    } else {
      console.log("Kondisi belum terpenuhi untuk play audio otomatis.");
      if (
        isLiveBroadcastActive &&
        !hasUserInteracted &&
        !document.getElementById("autoplay-instruction")
      ) {
        liveStatus.innerHTML +=
          "<br><span id='autoplay-instruction' style='color: orange;'>Klik di mana saja pada halaman untuk memutar siaran.</span>";
      }
    }
  }

  // Menangkap interaksi pengguna pertama kali di halaman
  document.body.addEventListener(
    "click",
    function handleUserInteraction() {
      if (!hasUserInteracted) {
        hasUserInteracted = true;
        console.log("Pengguna berinteraksi pertama kali.");
        attemptPlayAudio(); // Coba play setelah interaksi
      }
    },
    { once: true }
  );

  // Fungsi untuk mereset player dan MediaSource
  function resetLivePlayer() {
    console.log("Mereset live player...");
    if (mediaSource && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch (e) {
        console.warn("Gagal mengakhiri stream MediaSource saat reset:", e);
      }
    }
    if (livePlayer.src.startsWith("blob:")) {
      URL.revokeObjectURL(livePlayer.src);
    }
    livePlayer.src = "";
    livePlayer.load();
    mediaSource = null;
    sourceBuffer = null;
    audioQueue = [];
    livePlayer.pause();
    livePlayer.currentTime = 0;
    livePlayer.muted = true;
    receivedInitialHeader = false;
    isPlayerReadyForPlay = false; // BARU: Reset flag
  }

  // Fungsi untuk menyiapkan MediaSource dan SourceBuffer
  function setupLivePlayer() {
    console.log("Memulai setupLivePlayer...");
    if (!mediaSource || mediaSource.readyState === "closed") {
      try {
        mediaSource = new MediaSource();
        livePlayer.src = URL.createObjectURL(mediaSource);
        console.log(
          "MediaSource baru dibuat dan diassign ke livePlayer.src:",
          livePlayer.src
        );

        mediaSource.addEventListener("sourceopen", onSourceOpen);
        mediaSource.addEventListener("sourceended", () =>
          console.log("MediaSource ended")
        );
        mediaSource.addEventListener("sourceclose", () =>
          console.log("MediaSource closed")
        );
        mediaSource.addEventListener("error", (e) => {
          console.error("MediaSource error:", e);
          resetLivePlayer();
          liveStatus.innerHTML =
            "<span style='color: red;'>Error streaming. Coba refresh halaman.</span>";
        });
      } catch (e) {
        console.error(
          "MediaSource API tidak didukung atau gagal inisialisasi:",
          e
        );
        liveStatus.innerHTML = "Browser tidak mendukung streaming langsung.";
      }
    } else {
      console.log(
        "MediaSource sudah ada dan tidak ditutup. Skip pembuatan baru."
      );
      if (mediaSource.readyState === "open" && !sourceBuffer) {
        onSourceOpen();
      }
    }
  }

  // Fungsi yang dipanggil ketika MediaSource siap untuk menambahkan buffer
  function onSourceOpen() {
    console.log(
      "onSourceOpen dipanggil. MediaSource.readyState:",
      mediaSource.readyState
    );

    if (sourceBuffer && mediaSource.sourceBuffers.length > 0) {
      try {
        console.log("Mencoba menghapus SourceBuffer lama...");
        mediaSource.removeSourceBuffer(sourceBuffer);
        console.log("SourceBuffer lama berhasil dihapus.");
      } catch (e) {
        console.warn("Gagal menghapus SourceBuffer lama:", e);
      }
    }
    try {
      const mimeType = "audio/webm; codecs=opus";
      if (!MediaSource.isTypeSupported(mimeType)) {
        console.error(
          `Tipe MIME "${mimeType}" tidak didukung oleh browser ini.`
        );
        liveStatus.innerHTML =
          "Error streaming langsung: format audio tidak didukung oleh browser Anda.";
        return;
      }

      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      console.log("SourceBuffer baru dibuat. MimeType:", mimeType);

      sourceBuffer.addEventListener("updateend", () => {
        if (audioQueue.length > 0 && !sourceBuffer.updating) {
          try {
            sourceBuffer.appendBuffer(audioQueue.shift());
          } catch (error) {
            console.error(
              "Gagal menambahkan buffer ke antrian pada updateend (mungkin data rusak):",
              error
            );
            audioQueue.shift();
          }
        }
        isPlayerReadyForPlay = true; // BARU: Player siap setelah buffer pertama selesai
        attemptPlayAudio(); // Coba play lagi
      });

      sourceBuffer.addEventListener("error", (e) => {
        console.error("SourceBuffer error:", e);
        liveStatus.innerHTML =
          "<span style='color: red;'>Terjadi masalah pada aliran audio.</span>";
        resetLivePlayer();
      });

      // PENTING: Jangan langsung appendQueue di sini. Biarkan live_audio_header atau live_audio yang memicu append.
      // attemptPlayAudio(); // BARU: Coba play setelah SourceBuffer siap, tapi mungkin belum ada header
    } catch (e) {
      console.error(
        "Gagal menambahkan SourceBuffer (mungkin codec tidak didukung atau masalah lain):",
        e
      );
      liveStatus.innerHTML = "Error streaming langsung: codecs tidak didukung.";
    }
  }

  const formatDuration = (seconds) => {
    /* ... (tetap sama) ... */
    if (seconds === null || seconds === undefined || isNaN(seconds)) {
      return "";
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    const formatted = `${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
    return `| Durasi: ${formatted}`;
  };

  const fetchAndRenderArchives = async () => {
    /* ... (tetap sama) ... */
    const query = searchBox.value;
    const sort = sortOptions.value;
    try {
      const response = await fetch(
        `/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(
          sort
        )}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const results = await response.json();
      archiveList.innerHTML = "";
      if (results.length > 0) {
        results.forEach((b) => {
          archiveList.innerHTML += `
                    <div class="archive-item">
                      <div class="archive-info">
                        <span class="title">${b.title}</span>
                        <span class="meta">
                          ${b.date} | ${b.start_time}
                          ${formatDuration(b.duration)}
                        </span>
                      </div>
                      <audio controls preload="none" src="/rekaman/${
                        b.filename
                      }"></audio>
                    </div>
                  `;
        });
      } else {
        archiveList.innerHTML =
          '<p id="no-archives">Tidak ada rekaman ditemukan.</p>';
      }
    } catch (error) {
      console.error("Gagal mengambil atau merender arsip:", error);
      archiveList.innerHTML = '<p style="color: red;">Gagal memuat arsip.</p>';
    }
  };

  // --- Menerima initial audio header dari server ---
  socket.on("live_audio_header", (data) => {
    console.log("Menerima live_audio_header dari server.");
    if (
      data.header &&
      mediaSource &&
      mediaSource.readyState === "open" &&
      sourceBuffer
    ) {
      const headerArrayBuffer = new Uint8Array(data.header).buffer;
      if (!sourceBuffer.updating) {
        try {
          console.log("Menambahkan header audio awal ke SourceBuffer.");
          sourceBuffer.appendBuffer(headerArrayBuffer);
          receivedInitialHeader = true; // Set flag
          // Setelah header ditambahkan, coba proses antrean
          if (audioQueue.length > 0 && !sourceBuffer.updating) {
            console.log("Memproses antrean setelah header.");
            sourceBuffer.appendBuffer(audioQueue.shift());
          }
          isPlayerReadyForPlay = true; // BARU: Setelah header, player siap
          attemptPlayAudio(); // Coba play
        } catch (e) {
          console.error("Gagal menambahkan header audio awal:", e);
          resetLivePlayer();
        }
      } else {
        audioQueue.unshift(headerArrayBuffer);
        console.warn("SourceBuffer sedang update, mengantrikan header awal.");
      }
    } else {
      console.warn(
        "MediaSource/SourceBuffer belum siap saat header diterima. Mengantrikan header.",
        data.header
      );
      audioQueue.unshift(new Uint8Array(data.header).buffer);
    }
  });

  // Menerima audio chunk untuk siaran langsung
  socket.on("live_audio", (chunk) => {
    if (!receivedInitialHeader && isLiveBroadcastActive) {
      console.warn(
        "Menerima audio chunk sebelum header awal. Mengantrikan chunk sampai header diterima."
      );
      audioQueue.push(new Uint8Array(chunk).buffer);
      return;
    }

    if (!sourceBuffer || mediaSource.readyState !== "open") {
      console.warn(
        "SourceBuffer belum siap atau MediaSource tidak open. Mengantrikan chunk."
      );
      audioQueue.push(new Uint8Array(chunk).buffer);
      return;
    }
    const arrayBuffer = new Uint8Array(chunk).buffer;
    if (!sourceBuffer.updating) {
      try {
        sourceBuffer.appendBuffer(arrayBuffer);
        isPlayerReadyForPlay = true; // BARU: Setelah chunk pertama, player siap
        attemptPlayAudio(); // Coba play
      } catch (e) {
        console.error(
          "Error appending buffer (mungkin chunk rusak). Membuang chunk.",
          e
        );
      }
    } else {
      audioQueue.push(arrayBuffer);
    }
  });

  socket.on("broadcast_started", (data) => {
    console.log("Sinyal 'broadcast_started' diterima:", data.title);
    liveStatus.innerHTML = 'Sedang berlangsung: <span id="live-title"></span>';
    document.getElementById("live-title").textContent = data.title;
    livePlayer.style.display = "block";
    isLiveBroadcastActive = true;
    resetLivePlayer();
    setupLivePlayer();

    attemptPlayAudio(); // Coba play setelah broadcast dimulai
  });

  socket.on("broadcast_stopped", () => {
    console.log("Sinyal 'broadcast_stopped' diterima.");
    liveStatus.textContent = "Tidak ada siaran langsung saat ini.";
    livePlayer.style.display = "none";
    isLiveBroadcastActive = false;
    resetLivePlayer();

    const instructionSpan = document.getElementById("autoplay-instruction");
    if (instructionSpan) instructionSpan.remove();

    setTimeout(fetchAndRenderArchives, 1000);
  });

  searchBox.addEventListener("input", fetchAndRenderArchives);
  sortOptions.addEventListener("change", fetchAndRenderArchives);

  fetchAndRenderArchives();

  // --- Bagian Penting untuk Penanganan Refresh (Initial Load) ---
  if (
    livePlayer.style.display !== "none" &&
    liveStatus.textContent.includes("Sedang berlangsung")
  ) {
    console.log(
      "Siaran live ditemukan saat memuat halaman (initial load). Menyiapkan live player."
    );
    isLiveBroadcastActive = true;
    resetLivePlayer();
    setupLivePlayer();

    attemptPlayAudio(); // Coba play saat initial load
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const socket = io();
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const statusDiv = document.getElementById("status");
  const form = document.getElementById("broadcastForm");
  const formInputs = form.querySelectorAll("input");
  const btnForceStopServer = document.getElementById("btnForceStopServer");

  let mediaRecorder;
  let isBroadcasting = btnStop.disabled === false;
  let initialWebMHeader = null; // <-- BARU: Variabel untuk menyimpan header awal WebM

  // Set tanggal dan waktu hari ini secara default jika tidak ada siaran langsung
  if (!document.getElementById("date").value) {
    const now = new Date();
    document.getElementById("date").value = now.toISOString().split("T")[0];
    document.getElementById("startTime").value = now
      .toTimeString()
      .split(" ")[0]
      .substring(0, 5);
  }

  // Atur disabled state form inputs saat startup berdasarkan isBroadcasting
  if (isBroadcasting) {
    formInputs.forEach((input) => (input.disabled = true));
    statusDiv.style.color = "red";
  } else {
    statusDiv.style.color = "grey";
  }

  btnStart.addEventListener("click", startBroadcasting);
  btnStop.addEventListener("click", stopBroadcasting);

  if (btnForceStopServer) {
    btnForceStopServer.addEventListener("click", () => {
      if (
        confirm(
          "Anda yakin ingin menghentikan siaran ini di server? Ini akan menghentikan aliran audio ke pendengar dan menandai siaran sebagai selesai, tetapi tidak akan menghentikan rekaman di sisi browser Anda jika masih berjalan."
        )
      ) {
        socket.emit("force_stop_broadcast");
        isBroadcasting = false;
        btnStart.disabled = false;
        btnStop.disabled = true;
        formInputs.forEach((input) => (input.disabled = false));
        statusDiv.textContent = "Status: Tidak Siaran";
        statusDiv.style.color = "grey";
        btnForceStopServer.style.display = "none";
        if (mediaRecorder) {
          mediaRecorder.stop();
          mediaRecorder.stream.getTracks().forEach((track) => track.stop());
        }
        initialWebMHeader = null; // Reset header saat force stop
      }
    });
  }

  async function startBroadcasting() {
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        bitsPerSecond: 64000, // Opsional: Tentukan bitrate untuk kualitas/ukuran
      });

      const formData = new FormData(form);
      const broadcastData = {
        title: formData.get("title"),
        date: formData.get("date"),
        startTime: formData.get("startTime"),
      };

      // Kirim detail siaran ke server untuk memulai
      // Server perlu tahu bahwa ini adalah awal dari stream baru
      socket.emit("start_broadcast", broadcastData);

      // Event listener untuk data audio
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          // Jika ini chunk pertama, asumsikan ini adalah header atau inisialisasi segment
          if (!initialWebMHeader) {
            console.log(
              "Menerima chunk pertama, menyimpan sebagai header WebM awal."
            );
            initialWebMHeader = event.data; // Simpan blob header
            // KIRIM HEADER AWAL INI KE SERVER HANYA SEKALI SAAT BROADCAST DIMULAI
            // Server kemudian dapat mengirimkannya ke client baru yang bergabung
            socket.emit("initial_audio_header", {
              header: Array.from(new Uint8Array(event.data)),
            });
          }
          // Kirim chunk audio reguler
          socket.emit("audio_chunk", event.data);
        }
      };

      mediaRecorder.start(1000); // Kirim data setiap detik

      // Update UI
      isBroadcasting = true;
      btnStart.disabled = true;
      btnStop.disabled = false;
      formInputs.forEach((input) => (input.disabled = true));
      statusDiv.textContent = `Status: Sedang Siaran - ${broadcastData.title}`;
      statusDiv.style.color = "red";
      if (btnForceStopServer) {
        btnForceStopServer.style.display = "none";
      }
    } catch (error) {
      console.error("Error starting broadcast:", error);
      statusDiv.textContent =
        "Error: Gagal mengakses mikrofon atau memulai siaran.";
    }
  }

  function stopBroadcasting() {
    if (mediaRecorder && isBroadcasting) {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());

      const endTime = new Date().toTimeString().split(" ")[0].substring(0, 5);
      socket.emit("stop_broadcast", { endTime: endTime });

      isBroadcasting = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
      formInputs.forEach((input) => (input.disabled = false));
      statusDiv.textContent = "Status: Tidak Siaran";
      statusDiv.style.color = "grey";
      if (btnForceStopServer) {
        btnForceStopServer.style.display = "none";
      }
      initialWebMHeader = null; // Reset header saat siaran berhenti
    } else {
      console.warn(
        "MediaRecorder tidak aktif atau isBroadcasting false, tidak bisa menghentikan siaran."
      );
      if (
        confirm(
          "Siaran mungkin masih aktif di server. Apakah Anda ingin menghentikannya secara paksa dari server?"
        )
      ) {
        socket.emit("force_stop_broadcast");
      }
    }
  }

  socket.on("broadcast_stopped", () => {
    console.log("Sinyal 'broadcast_stopped' diterima di penyiar.");
    isBroadcasting = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    formInputs.forEach((input) => (input.disabled = false));
    statusDiv.textContent = "Status: Tidak Siaran";
    statusDiv.style.color = "grey";
    if (btnForceStopServer) {
      btnForceStopServer.style.display = "none";
    }
    initialWebMHeader = null; // Reset header saat siaran berhenti
  });

  if (isBroadcasting && !mediaRecorder) {
    statusDiv.innerHTML = `<span style="color: red;">Sedang Siaran - ${
      document.getElementById("title").value || "judul tidak diketahui"
    }</span><br><small>(Siaran ini dimulai sebelum halaman di-refresh. Kontrol rekaman audio di browser hilang. Gunakan "Hentikan Siaran di Server" untuk menghentikan aliran ke pendengar.)</small>`;
    btnStop.style.display = "none";
    if (btnForceStopServer) {
      btnForceStopServer.style.display = "inline-block";
    }
  }
});

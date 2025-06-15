import os
import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from sqlalchemy import or_, desc, asc
from models import db, Broadcast

# --- Konfigurasi Aplikasi (Tetap Sama) ---
app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'mysql+pymysql://root:@localhost/suara_radio_mahasiswa'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'kunci-rahasia-yang-sangat-aman'

db.init_app(app)
socketio = SocketIO(app)

rekaman_folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rekaman')

if not os.path.exists(rekaman_folder):
    os.makedirs(rekaman_folder)
if not os.path.exists(app.instance_path):
    os.makedirs(app.instance_path)

with app.app_context():
    db.create_all()
    live_broadcast_on_startup = Broadcast.query.filter_by(is_live=True).first()
    if live_broadcast_on_startup:
        print(f"Ditemukan siaran langsung aktif dari DB: {live_broadcast_on_startup.title}")
    else:
        print("Tidak ada siaran langsung aktif yang ditemukan di DB saat startup.")

active_broadcast_id = live_broadcast_on_startup.id if live_broadcast_on_startup else None
start_time_obj = None

file_writer = None

# --- BARU: Variabel global untuk menyimpan header audio awal ---
current_broadcast_header = None
# --- BARU: Untuk melacak sesi socket yang terhubung agar bisa mengirim header ke yang baru bergabung ---
connected_clients = set()


@app.route('/')
def index():
    live_broadcast = Broadcast.query.filter_by(is_live=True).first()
    return render_template('penyiar.html', live_broadcast=live_broadcast)

@app.route('/penyiar')
def penyiar_page():
    live_broadcast = Broadcast.query.filter_by(is_live=True).first()
    return render_template('penyiar.html', live_broadcast=live_broadcast)

@app.route('/client')
def client_page():
    arsip = Broadcast.query.filter_by(is_live=False).order_by(Broadcast.id.desc()).all()
    live_broadcast = Broadcast.query.filter_by(is_live=True).first()
    return render_template('client.html', arsip=arsip, live_broadcast=live_broadcast)

@app.route('/rekaman/<filename>')
def serve_recording(filename):
    return send_from_directory(rekaman_folder, filename)

@app.route('/search')
def search_broadcasts():
    query = request.args.get('q', '')
    sort_by = request.args.get('sort', 'date_desc')
    search_query = Broadcast.query.filter(
        or_(Broadcast.title.like(f"%{query}%"), Broadcast.broadcast_date.like(f"%{query}%"))
    )
    if sort_by == 'title_asc':
        search_query = search_query.order_by(asc(Broadcast.title))
    elif sort_by == 'title_desc':
        search_query = search_query.order_by(desc(Broadcast.title))
    elif sort_by == 'date_asc':
        search_query = search_query.order_by(asc(Broadcast.broadcast_date), asc(Broadcast.start_time))
    else:
        search_query = search_query.order_by(desc(Broadcast.broadcast_date), desc(Broadcast.start_time))

    results = search_query.filter_by(is_live=False).all()

    broadcast_list = [{
        'id': b.id,
        'title': b.title,
        'date': b.broadcast_date,
        'start_time': b.start_time,
        'filename': b.filename,
        'duration': b.duration_in_seconds
    } for b in results]

    return jsonify(broadcast_list)

# --- Logika WebSocket (SocketIO) ---

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")
    connected_clients.add(request.sid)
    # Jika ada siaran langsung aktif dan header tersedia, kirim ke client baru
    if active_broadcast_id and current_broadcast_header:
        print(f"Mengirim header audio awal ke client baru: {request.sid}")
        # Kirim header hanya ke client yang baru terhubung (dengan request.sid)
        emit('live_audio_header', {'header': current_broadcast_header}, room=request.sid)

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")
    connected_clients.remove(request.sid)

@socketio.on('start_broadcast')
def handle_start_broadcast(data):
    global active_broadcast_id, start_time_obj, file_writer, current_broadcast_header

    existing_live = Broadcast.query.filter_by(is_live=True).first()
    if existing_live:
        print(f"Siaran '{existing_live.title}' sudah berlangsung. Menghentikan siaran lama.")
        existing_live.is_live = False
        existing_live.end_time = datetime.datetime.now().strftime("%H:%M")
        if file_writer:
            file_writer.close()
            file_writer = None
        db.session.commit()

    start_time_obj = datetime.datetime.now()

    timestamp = start_time_obj.strftime("%Y%m%d_%H%M%S")
    filename = f"siaran_{timestamp}.webm"

    new_broadcast = Broadcast(
        title=data['title'],
        broadcast_date=data['date'],
        start_time=data['startTime'],
        filename=filename,
        is_live=True
    )
    db.session.add(new_broadcast)
    db.session.commit()

    active_broadcast_id = new_broadcast.id
    current_broadcast_file = os.path.join(rekaman_folder, filename)

    try:
        file_writer = open(current_broadcast_file, 'wb')
        emit('broadcast_started', {'title': new_broadcast.title}, broadcast=True)
        print(f"Siaran '{data['title']}' dimulai, merekam ke {filename}")
        current_broadcast_header = None # Reset header saat broadcast baru dimulai
    except Exception as e:
        print(f"Gagal memulai rekaman: {e}")

@socketio.on('initial_audio_header') # <-- BARU: Menerima header awal dari penyiar
def handle_initial_audio_header(data):
    global current_broadcast_header
    # Konversi list kembali ke bytes
    current_broadcast_header = bytes(data['header'])
    print("Menerima dan menyimpan header audio awal dari penyiar.")
    # Kita tidak perlu mengirim ulang header ke semua client yang sudah ada,
    # karena mereka akan mendapatkan 'broadcast_started' dan akan meminta header ini jika diperlukan (saat refresh).
    # Client baru akan mendapatkannya saat connect.

@socketio.on('audio_chunk')
def handle_audio_chunk(chunk):
    # Emit audio chunk ke semua client yang terhubung
    emit('live_audio', chunk, broadcast=True)
    if file_writer:
        try:
            file_writer.write(chunk)
        except Exception as e:
            print(f"Gagal menulis chunk: {e}")

@socketio.on('stop_broadcast')
def handle_stop_broadcast(data):
    global active_broadcast_id, start_time_obj, file_writer, current_broadcast_header

    if file_writer:
        file_writer.close()
        file_writer = None

    if active_broadcast_id and start_time_obj:
        broadcast_to_stop = Broadcast.query.get(active_broadcast_id)
        if broadcast_to_stop:
            end_time_obj = datetime.datetime.now()
            duration = end_time_obj - start_time_obj
            broadcast_to_stop.duration_in_seconds = int(duration.total_seconds())

            broadcast_to_stop.is_live = False
            broadcast_to_stop.end_time = data['endTime']
            db.session.commit()

    emit('broadcast_stopped', {}, broadcast=True)
    print(f"Siaran dihentikan. Durasi: {duration.total_seconds()} detik.")
    active_broadcast_id = None
    start_time_obj = None
    current_broadcast_header = None # Hapus header saat siaran berhenti

@socketio.on('force_stop_broadcast')
def handle_force_stop_broadcast():
    global active_broadcast_id, start_time_obj, file_writer, current_broadcast_header

    print("Menerima sinyal 'force_stop_broadcast'.")
    if file_writer:
        try:
            file_writer.close()
            print("File writer ditutup karena force stop.")
        except Exception as e:
            print(f"Gagal menutup file writer saat force stop: {e}")
        file_writer = None

    if active_broadcast_id:
        broadcast_to_stop = Broadcast.query.get(active_broadcast_id)
        if broadcast_to_stop:
            broadcast_to_stop.duration_in_seconds = None
            broadcast_to_stop.is_live = False
            broadcast_to_stop.end_time = datetime.datetime.now().strftime("%H:%M")
            db.session.commit()
            print(f"Siaran '{broadcast_to_stop.title}' dihentikan secara paksa di DB.")

    emit('broadcast_stopped', {}, broadcast=True)
    active_broadcast_id = None
    start_time_obj = None
    current_broadcast_header = None # Hapus header saat force stop
    print("Status siaran di server direset.")


if __name__ == '__main__':
    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)
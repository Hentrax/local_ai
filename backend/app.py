# backend/app.py
import os
import ollama
import json
import uuid
from flask import Flask, request, jsonify, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
import logging
import re # <-- Importer le module pour les expressions régulières

# Imports pour l'extraction de texte
import PyPDF2
import docx # python-docx
import openpyxl

# ... (le reste des imports et configurations initiales reste identique) ...
logging.basicConfig(level=logging.INFO)
app = Flask(__name__, static_folder='../frontend', static_url_path='')
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
LOG_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
ALLOWED_EXTENSIONS = {'pdf', 'docx', 'xlsx', 'txt'}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(LOG_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['LOG_FOLDER'] = LOG_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
current_model = 'deepseek-r1:14b' # Ton modèle par défaut
current_conversation_history = []
current_conversation_id = None
uploaded_file_context = {}

# --- Fonctions Utilitaires (allowed_file, generate_log_filename, save_log, load_log, extract_text_from_file) ---
# ... (Ces fonctions restent identiques à la version précédente) ...
def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def generate_log_filename(conv_id):
    return os.path.join(app.config['LOG_FOLDER'], f"conversation_{conv_id}.json")

def save_log(conv_id, history):
    if not conv_id:
        logging.warning("Tentative de sauvegarde sans ID de conversation.")
        return
    log_file = generate_log_filename(conv_id)
    try:
        with open(log_file, 'w', encoding='utf-8') as f:
            json.dump(history, f, ensure_ascii=False, indent=4)
        logging.info(f"Conversation {conv_id} sauvegardée dans {log_file}")
    except Exception as e:
        logging.error(f"Erreur lors de la sauvegarde du log {conv_id}: {e}")

def load_log(conv_id):
    log_file = generate_log_filename(conv_id)
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logging.error(f"Erreur lors du chargement du log {conv_id}: {e}")
            return []
    return []

def extract_text_from_file(filepath):
    filename = os.path.basename(filepath)
    ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
    text = ""
    try:
        if ext == 'pdf':
            with open(filepath, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                if reader.is_encrypted:
                     try: reader.decrypt('')
                     except: logging.error(f"Échec déchiffrement PDF {filename}"); return None
                for page in reader.pages: text += (page.extract_text() or "") + "\n" # Handle None
        elif ext == 'docx':
            doc = docx.Document(filepath);
            for para in doc.paragraphs: text += para.text + "\n"
        elif ext == 'xlsx':
            workbook = openpyxl.load_workbook(filepath, data_only=True, read_only=True)
            for sheetname in workbook.sheetnames:
                sheet = workbook[sheetname]
                for row in sheet.iter_rows():
                    row_text = [str(cell.value).strip() for cell in row if cell.value is not None]
                    if row_text: text += "\t".join(row_text) + "\n"
        elif ext == 'txt':
            encodings_to_try = ['utf-8', 'latin-1', 'windows-1252']
            read_success = False
            for enc in encodings_to_try:
                try:
                    with open(filepath, 'r', encoding=enc) as f: text = f.read(); read_success = True; break
                except UnicodeDecodeError: continue
                except Exception as e: logging.error(f"Err lecture txt {filename} {enc}: {e}"); return None
            if not read_success: logging.error(f"Impossible décoder txt {filename}"); return None
        else: logging.warning(f"Extraction non supportée: {ext}"); return None

        extracted_text = text.strip()
        if not extracted_text: logging.warning(f"Aucun texte extrait de {filename}"); return None
        logging.info(f"Texte extrait de {filename} ({len(extracted_text)} chars)")
        return extracted_text
    except Exception as e:
        logging.error(f"Erreur extraction {filename} ({ext}): {e}", exc_info=True); return None


# --- Routes API ---

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/set_model', methods=['POST'])
def set_model():
    """Change le modèle Ollama utilisé et démarre une nouvelle conversation."""
    global current_model, uploaded_file_context
    try: # Englober plus de code dans le try pour attraper les erreurs tôt
        data = request.json
        model_size = data.get('model_size')

        if not model_size:
             return jsonify({"success": False, "message": "Taille du modèle non fournie."}), 400

        model_mapping = { # Tes modèles
            "1.5b": "deepseek-r1:1.5b", "7b": "deepseek-r1:7b", "8b": "deepseek-r1:8b",
            "14b": "deepseek-r1:14b", "32b": "deepseek-r1:32b", "70b": "deepseek-r1:70b",
            "671b": "deepseek-r1:671b", "r1-14b": "deepseek-r1:14b"
        }
        selected_model_name = model_mapping.get(model_size)

        if not selected_model_name:
             logging.error(f"Aucun modèle correspondant trouvé dans le mapping pour la clé: {model_size}")
             return jsonify({"success": False, "message": f"Clé de modèle '{model_size}' inconnue dans le mapping."}), 400

        logging.info(f"Tentative de changement de modèle vers : {selected_model_name} (demandé via '{model_size}')")

        # Vérifie si le modèle existe localement via l'API ollama
        ollama.show(selected_model_name) # Peut lever ollama.ResponseError

        # Si ça ne lève pas d'exception, le modèle existe
        current_model = selected_model_name
        logging.info(f"Modèle changé avec succès pour : {current_model}")

        # Démarrer une nouvelle conversation
        start_new_chat_internal() # Peut lever une exception si bug interne

        # Si tout va bien jusqu'ici, renvoyer JSON succès
        return jsonify({
            "success": True,
            "message": f"Modèle changé pour {current_model}. Nouvelle conversation démarrée.",
            "conversation_id": current_conversation_id
        })

    except ollama.ResponseError as e:
         # Gère l'erreur spécifique Ollama (modèle non trouvé)
         logging.error(f"Erreur Ollama vérif/changement modèle '{selected_model_name}': {e.status_code} {e.error}")
         return jsonify({
             "success": False,
             "message": f"Modèle '{selected_model_name}' non trouvé ou invalide (Ollama error). Vérifiez 'ollama list'."}), 400

    except Exception as e:
         # *** NOUVEAU BLOC : Intercepte TOUTES les autres erreurs ***
         logging.error(f"Erreur inattendue dans /set_model: {e}", exc_info=True) # exc_info=True loggue la stack trace
         return jsonify({
             "success": False,
             "message": "Une erreur interne est survenue lors du changement de modèle."
         }), 500 # 500 Internal Server Error

@app.route('/chat', methods=['POST'])
def chat():
    global current_conversation_history, current_conversation_id, uploaded_file_context
    data = request.json
    user_input = data.get('message')
    if not user_input: return jsonify({"error": "Message vide reçu."}), 400
    if not current_conversation_id: start_new_chat_internal()

    # Ajoute message user à l'historique PERSISTANT
    current_conversation_history.append({'role': 'user', 'content': user_input})

    # Prépare copie pour Ollama
    history_for_ollama = list(current_conversation_history)

    # Injecte contexte fichier si présent
    file_ctx = uploaded_file_context.get(current_conversation_id)
    if file_ctx and file_ctx.get('content'):
        logging.info(f"Injection contexte fichier '{file_ctx['filename']}' ({len(file_ctx['content'])} chars)")
        context_prompt = (
            f"CONTEXTE IMPORTANT FOURNI PAR L'UTILISATEUR :\n"
            f"Contenu du fichier '{file_ctx['filename']}':\n"
            f"--- DEBUT DU CONTENU ---\n{file_ctx['content']}\n--- FIN DU CONTENU ---\n"
            f"FIN DU CONTEXTE. Utilisez ces informations si pertinent pour répondre."
        )
        history_for_ollama.insert(0, {"role": "system", "content": context_prompt})
        if len(file_ctx['content']) > 15000: logging.warning("Contexte fichier > 15k chars, risque limite modèle.")

    logging.info(f"Envoi à Ollama ({current_model}) historique {len(history_for_ollama)} messages.")

    try:
        # Appel Ollama
        response = ollama.chat(
            model=current_model,
            messages=history_for_ollama,
            stream=False
        )
        full_ai_response = response['message']['content']
        logging.debug(f"Réponse BRUTE de l'IA: {full_ai_response[:500]}...") # Log début réponse brute

        # *** NOUVEAU: Séparation Think / Visible ***
        thinking_text = ""
        visible_text = full_ai_response # Par défaut, tout est visible

        # Regex pour trouver <think>...</think> (non-gourmand, insensible casse, dotall)
        think_match = re.search(r"<think>(.*?)</think>", full_ai_response, re.IGNORECASE | re.DOTALL)

        if think_match:
            thinking_text = think_match.group(1).strip() # Extrait le contenu
             # Supprime le bloc <think>...</think> de la réponse visible
            visible_text = re.sub(r"<think>.*?</think>", "", full_ai_response, count=1, flags=re.IGNORECASE | re.DOTALL).strip()
            logging.info(f"Partie 'think' détectée ({len(thinking_text)} chars), partie visible ({len(visible_text)} chars)")
        else:
            logging.info("Aucune balise <think> détectée dans la réponse.")


        # *** MODIFIÉ: Ajoute UNIQUEMENT la partie VISIBLE à l'historique PERSISTANT ***
        current_conversation_history.append({'role': 'assistant', 'content': visible_text})

        # Sauvegarde l'historique PERSISTANT (qui contient maintenant visible_text)
        save_log(current_conversation_id, current_conversation_history)

        # *** MODIFIÉ: Renvoie les deux parties au frontend ***
        return jsonify({
            "visible_response": visible_text,
            "thinking_process": thinking_text # Sera vide si pas de <think> trouvé
        })

    except ollama.ResponseError as e:
        logging.error(f"Erreur Ollama: {e.status_code} {e.error}")
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user': current_conversation_history.pop()
        error_message = f"Erreur Ollama ({e.status_code})."
        if "context window" in str(e.error).lower(): error_message += " Contexte trop long (fichier?)."
        elif "not found" in str(e.error).lower(): error_message += f" Modèle '{current_model}' non trouvé."
        else: error_message += f" Détail: {e.error}"
        return jsonify({"error": error_message}), 500
    except Exception as e:
        logging.error(f"Erreur inattendue chat: {e}", exc_info=True)
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user': current_conversation_history.pop()
        return jsonify({"error": "Erreur interne inattendue."}), 500


@app.route('/upload', methods=['POST'])
def upload_file():
    global uploaded_file_context, current_conversation_id
    if 'file' not in request.files: return jsonify({"error": "Aucun fichier."}), 400
    file = request.files['file']
    if file.filename == '': return jsonify({"error": "Nom fichier vide."}), 400
    if not allowed_file(file.filename):
        allowed_types_str = ", ".join(ALLOWED_EXTENSIONS)
        return jsonify({"error": f"Type fichier non autorisé ({allowed_types_str})."}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    try:
        file.save(filepath)
        logging.info(f"Fichier '{filename}' sauvegardé: {filepath}")
        extracted_text = extract_text_from_file(filepath)
        if extracted_text is not None:
             if not current_conversation_id: start_new_chat_internal()
             uploaded_file_context[current_conversation_id] = {"filename": filename, "content": extracted_text}
             logging.info(f"Texte '{filename}' ({len(extracted_text)} chars) stocké pour conv {current_conversation_id}.")
             return jsonify({"success": True,"message": f"'{filename}' uploadé et traité ({len(extracted_text)} cars). Posez vos questions.","filename": filename})
        else:
             return jsonify({"error": f"'{filename}' uploadé mais échec extraction contenu."}), 422
    except Exception as e:
        logging.error(f"Erreur upload/traitement '{filename}': {e}", exc_info=True)
        return jsonify({"error": "Erreur serveur upload/traitement fichier."}), 500

# --- Fonctions Internes et Routes Historique (start_new_chat_internal, new_chat, get_history_list, get_conversation) ---
# ... (Ces fonctions restent identiques à la version précédente) ...
def start_new_chat_internal():
    global current_conversation_history, current_conversation_id, uploaded_file_context
    if current_conversation_id in uploaded_file_context:
        logging.info(f"Nettoyage contexte fichier ancienne conv {current_conversation_id}")
        del uploaded_file_context[current_conversation_id]
    current_conversation_id = str(uuid.uuid4())
    current_conversation_history = []
    logging.info(f"Nouvelle conversation démarrée: {current_conversation_id}")

@app.route('/new_chat', methods=['POST'])
def new_chat():
    start_new_chat_internal()
    return jsonify({"success": True, "message": "Nouveau chat démarré.", "conversation_id": current_conversation_id})

@app.route('/history', methods=['GET'])
def get_history_list():
    try:
        log_files = [f for f in os.listdir(app.config['LOG_FOLDER']) if f.startswith("conversation_") and f.endswith(".json")]
        log_files.sort(key=lambda f: os.path.getmtime(os.path.join(app.config['LOG_FOLDER'], f)), reverse=True)
        conversations = []
        for filename in log_files:
            conv_id = filename.replace("conversation_", "").replace(".json", "")
            try:
                filepath = os.path.join(app.config['LOG_FOLDER'], filename)
                mtime = os.path.getmtime(filepath)
                dt_object = datetime.fromtimestamp(mtime)
                conversations.append({"id": conv_id, "name": f"Chat du {dt_object.strftime('%d/%m/%Y %H:%M')}"})
            except Exception as e:
                logging.warning(f"Err traitement log {filename}: {e}")
                conversations.append({"id": conv_id, "name": f"Conv {conv_id[:8]} (err date)"})
        return jsonify({"conversations": conversations})
    except Exception as e:
        logging.error(f"Err lecture historique: {e}", exc_info=True)
        return jsonify({"error": "Impossible lister historique."}), 500

@app.route('/history/<conversation_id>', methods=['GET'])
def get_conversation(conversation_id):
    global current_conversation_history, current_conversation_id, uploaded_file_context
    try: uuid.UUID(conversation_id, version=4)
    except ValueError: return jsonify({"error": "ID conversation invalide."}), 400

    history = load_log(conversation_id)
    if history:
        if current_conversation_id and current_conversation_id in uploaded_file_context:
            logging.info(f"Nettoyage contexte fichier ancienne conv {current_conversation_id} lors chargement {conversation_id}")
            del uploaded_file_context[current_conversation_id]
        if conversation_id in uploaded_file_context:
             logging.info(f"Nettoyage contexte fichier résiduel conv chargée {conversation_id}")
             del uploaded_file_context[conversation_id]

        current_conversation_id = conversation_id
        current_conversation_history = history
        logging.info(f"Conversation {conversation_id} chargée depuis log.")
        return jsonify({"id": conversation_id, "history": history, "file_context_status": "Contexte fichier non chargé depuis historique."})
    else:
        logging.warning(f"Conversation non trouvée logs ID: {conversation_id}")
        return jsonify({"error": "Conversation non trouvée ou impossible à charger."}), 404


if __name__ == '__main__':
    print(f"--- Démarrage Serveur Flask ---")
    print(f"Modèle Ollama par défaut: {current_model}")
    print(f"Accès via: http://127.0.0.1:5000")
    print(f"---------------------------------")
    app.run(debug=True, host='127.0.0.1', port=5000)
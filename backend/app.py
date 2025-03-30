# backend/app.py
import os
import ollama
import json
import uuid
from flask import Flask, request, jsonify, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
import logging
import re

# ... (autres imports et config initiale : logging, flask app, folders, extensions) ...
logging.basicConfig(level=logging.INFO)
app = Flask(__name__, static_folder='../frontend', static_url_path='')
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
LOG_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
ALLOWED_EXTENSIONS = {'pdf', 'docx', 'xlsx', 'txt'}
os.makedirs(UPLOAD_FOLDER, exist_ok=True); os.makedirs(LOG_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER; app.config['LOG_FOLDER'] = LOG_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

# --- État Global ---
# Définir un modèle par défaut COMPLET qui est probablement installé
try:
    # Essayons un modèle commun ou ton préféré comme défaut initial
    default_model_check = 'deepseek-r1:14b' # Ou 'llama3:8b', 'mistral:7b' etc.
    ollama.show(default_model_check)
    current_model = default_model_check
    logging.info(f"Modèle par défaut fonctionnel trouvé et défini sur: {current_model}")
except ollama.ResponseError:
    logging.warning(f"Modèle par défaut '{default_model_check}' non trouvé. Tentative avec 'llama3:8b'.")
    try:
        ollama.show('llama3:8b')
        current_model = 'llama3:8b'
        logging.info("Modèle par défaut défini sur: llama3:8b")
    except ollama.ResponseError:
         logging.error("Aucun modèle par défaut commun (deepseek-r1:14b, llama3:8b) trouvé. L'application pourrait ne pas fonctionner sans sélection manuelle.")
         # Mettre une valeur placeholder, mais elle causera une erreur si utilisée
         current_model = "default:latest" # Placeholder
except Exception as e:
    logging.error(f"Erreur inattendue lors de la vérification du modèle par défaut: {e}")
    current_model = "error:latest" # Placeholder


current_conversation_history = []
current_conversation_id = None
uploaded_file_context = {}
# NOUVEAU: Cache simple pour la liste des modèles (pour éviter appels Ollama répétés)
available_models_cache = None
cache_timestamp = None

# --- Fonctions Utilitaires (restent identiques) ---
def allowed_file(filename): return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS
def generate_log_filename(conv_id): return os.path.join(app.config['LOG_FOLDER'], f"conversation_{conv_id}.json")
def save_log(conv_id, history):
    if not conv_id: logging.warning("Sauvegarde sans ID conv."); return
    try:
        with open(generate_log_filename(conv_id), 'w', encoding='utf-8') as f: json.dump(history, f, ensure_ascii=False, indent=4)
        logging.info(f"Conv {conv_id} sauvegardée.")
    except Exception as e: logging.error(f"Err sauvegarde log {conv_id}: {e}")
def load_log(conv_id):
    log_file = generate_log_filename(conv_id)
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r', encoding='utf-8') as f: return json.load(f)
        except Exception as e: logging.error(f"Err chargement log {conv_id}: {e}"); return []
    return []
# ... extract_text_from_file reste identique ...
from PyPDF2 import PdfReader; import docx; import openpyxl
def extract_text_from_file(filepath):
    filename = os.path.basename(filepath)
    ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
    text = ""
    try:
        if ext == 'pdf':
            with open(filepath, 'rb') as f:
                reader = PdfReader(f)
                if reader.is_encrypted:
                     try: reader.decrypt(''); logging.info(f"PDF {filename} déchiffré (sans mdp).")
                     except: logging.error(f"Échec déchiffrement PDF {filename}"); return None
                for page in reader.pages: text += (page.extract_text() or "") + "\n"
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
            encodings_to_try = ['utf-8', 'latin-1', 'windows-1252']; read_success = False
            for enc in encodings_to_try:
                try:
                    with open(filepath, 'r', encoding=enc) as f: text = f.read(); read_success = True; break
                except UnicodeDecodeError: continue
                except Exception as e: logging.error(f"Err lecture txt {filename} {enc}: {e}"); return None
            if not read_success: logging.error(f"Impossible décoder txt {filename}"); return None
        else: logging.warning(f"Extraction non supportée: {ext}"); return None
        extracted_text = text.strip();
        if not extracted_text: logging.warning(f"Aucun texte extrait {filename}"); return None
        logging.info(f"Texte extrait {filename} ({len(extracted_text)} chars)")
        return extracted_text
    except Exception as e: logging.error(f"Erreur extraction {filename} ({ext}): {e}", exc_info=True); return None


# --- Routes API ---

@app.route('/')
def index(): return send_from_directory(app.static_folder, 'index.html')

# *** NOUVELLE ROUTE pour obtenir les modèles structurés ***
@app.route('/api/models', methods=['GET'])
def get_available_models():
    global available_models_cache, cache_timestamp
    if available_models_cache and cache_timestamp and (datetime.now() - cache_timestamp).total_seconds() < 300:
        logging.info("Utilisation du cache pour la liste des modèles.")
        return jsonify({"models": available_models_cache, "default_model": current_model})

    logging.info(">>> Début récupération de la liste des modèles depuis Ollama.")
    structured_models = {}
    try:
        # *** CORRECTION : Appeler ollama.list() et accéder à l'attribut .models ***
        list_response = ollama.list()
        logging.info(f">>> Réponse de ollama.list(): Type={type(list_response)}") # Log le type

        # Vérifie si la réponse a bien un attribut 'models' qui est une liste
        if not hasattr(list_response, 'models') or not isinstance(list_response.models, list):
             logging.error(f"Format inattendu reçu de ollama.list(). Attribut 'models' manquant ou n'est pas une liste.")
             raise ValueError("Format de réponse Ollama inattendu (attribut models)")

        models_list = list_response.models # Accède à la liste des objets Model

        if not models_list:
             logging.warning("ollama.list() a retourné une liste de modèles VIDE.")
        else:
             logging.info(f"Traitement de {len(models_list)} modèle(s) trouvé(s)...")

        # *** CORRECTION : Accéder à l'attribut .model de chaque objet Model ***
        for model_obj in models_list:
            logging.debug(f"  Traitement objet Model: {model_obj}")

            # Accède au nom complet via l'attribut .model
            full_name = model_obj.model # model_obj est un objet Model, on prend son attribut .model

            if not full_name or not isinstance(full_name, str):
                logging.warning(f"  Skipping: Nom de modèle invalide ou manquant dans {model_obj}")
                continue

            # Le reste de la logique de split est OK
            base_name, tag = '', ''
            if ':' in full_name:
                try: base_name, tag = full_name.split(':', 1)
                except ValueError: logging.warning(f"  Skipping: split impossible '{full_name}'"); continue
            else:
                base_name = full_name; tag = 'latest'

            if not base_name or not tag: logging.warning(f"  Skipping: base/tag vide pour '{full_name}'"); continue

            logging.debug(f"    -> Base='{base_name}', Tag='{tag}'")

            # Ajout à la structure (pas de changement ici)
            if base_name not in structured_models: structured_models[base_name] = []
            if tag not in structured_models[base_name]:
                structured_models[base_name].append(tag)
                structured_models[base_name].sort()

        logging.info(f">>> Dictionnaire structuré FINAL: {structured_models}")
        available_models_cache = structured_models; cache_timestamp = datetime.now()
        logging.info(f"<<< Fin récupération modèles. {len(structured_models)} bases structurées.")

        return jsonify({ "models": structured_models, "default_model": current_model })

    except ollama.ResponseError as e:
        logging.error(f">>> Erreur Ollama list(): Status={e.status_code}, Error='{e.error}'", exc_info=True)
        return jsonify({"error": f"Impossible de lister modèles via Ollama: {e.error}"}), 502
    except Exception as e:
        logging.error(f">>> Erreur inattendue get_available_models: {e}", exc_info=True)
        return jsonify({"error": "Erreur interne récupération liste modèles."}), 500


# *** ROUTE MODIFIÉE pour définir le modèle ***
@app.route('/set_model', methods=['POST'])
def set_model():
    """Définit le modèle basé sur le nom de base et le tag reçus."""
    global current_model, uploaded_file_context
    try:
        data = request.json
        base_model = data.get('base_model')
        tag = data.get('tag')

        if not base_model or not tag:
             return jsonify({"success": False, "message": "Nom de base ou tag manquant."}), 400

        # Reconstruit le nom complet
        full_model_name = f"{base_model}:{tag}"
        logging.info(f"Tentative de changement de modèle vers : {full_model_name}")

        # Vérifie si le modèle reconstruit existe
        ollama.show(full_model_name) # Peut lever ollama.ResponseError

        # Le modèle existe, on le définit comme courant
        current_model = full_model_name
        logging.info(f"Modèle changé avec succès pour : {current_model}")

        # Démarre une nouvelle conversation (efface historique et contexte fichier)
        start_new_chat_internal()

        return jsonify({
            "success": True,
            "message": f"Modèle changé pour {current_model}. Nouvelle conversation démarrée.",
            "conversation_id": current_conversation_id
        })

    except ollama.ResponseError as e:
         # Gère l'erreur spécifique Ollama (modèle non trouvé)
         logging.error(f"Erreur Ollama vérif/changement modèle '{full_model_name}': {e.status_code} {e.error}")
         return jsonify({
             "success": False,
             # Ne pas changer current_model si l'autre n'est pas valide
             "message": f"Modèle '{full_model_name}' non trouvé ou invalide (Ollama error)."}), 400

    except Exception as e:
         # Intercepte TOUTES les autres erreurs
         logging.error(f"Erreur inattendue dans /set_model: {e}", exc_info=True)
         return jsonify({
             "success": False,
             "message": "Une erreur interne est survenue lors du changement de modèle."
         }), 500


# ... (Les routes /chat, /upload, /new_chat, /history, /history/<id> et la fonction start_new_chat_internal
#      restent identiques à la version précédente où le 'return jsonify' de /chat
#      renvoie bien "visible_response" et "thinking_process") ...

@app.route('/chat', methods=['POST'])
def chat():
    global current_conversation_history, current_conversation_id, uploaded_file_context
    data = request.json
    user_input = data.get('message')
    if not user_input: return jsonify({"error": "Message vide."}), 400
    if not current_conversation_id: start_new_chat_internal()

    current_conversation_history.append({'role': 'user', 'content': user_input})
    history_for_ollama = list(current_conversation_history)
    file_ctx = uploaded_file_context.get(current_conversation_id)
    if file_ctx and file_ctx.get('content'):
        logging.info(f"Inject contexte '{file_ctx['filename']}' ({len(file_ctx['content'])} chars)")
        context_prompt = (f"CONTEXTE FICHIER '{file_ctx['filename']}':\n"
                          f"--- DEBUT ---\n{file_ctx['content']}\n--- FIN ---\n")
        history_for_ollama.insert(0, {"role": "system", "content": context_prompt})
        if len(file_ctx['content']) > 15000: logging.warning("Contexte fichier > 15k chars.")

    logging.info(f"Envoi à Ollama ({current_model}) hist {len(history_for_ollama)} msgs.")
    try:
        response = ollama.chat(model=current_model, messages=history_for_ollama, stream=False)
        full_ai_response = response['message']['content']
        thinking_text = ""; visible_text = full_ai_response
        think_match = re.search(r"<think>(.*?)</think>", full_ai_response, re.IGNORECASE | re.DOTALL)
        if think_match:
            thinking_text = think_match.group(1).strip()
            visible_text = re.sub(r"<think>.*?</think>", "", full_ai_response, count=1, flags=re.IGNORECASE | re.DOTALL).strip()
            logging.info(f"Think détecté ({len(thinking_text)}c), visible ({len(visible_text)}c)")
        current_conversation_history.append({'role': 'assistant', 'content': visible_text}) # Sauvegarde partie visible
        save_log(current_conversation_id, current_conversation_history)
        return jsonify({"visible_response": visible_text, "thinking_process": thinking_text}) # Renvoie les deux
    except ollama.ResponseError as e:
        logging.error(f"Err Ollama: {e.status_code} {e.error}"); error_message = f"Err Ollama ({e.status_code})."
        if "context window" in str(e.error).lower(): error_message += " Contexte trop long?"
        elif "not found" in str(e.error).lower(): error_message += f" Modèle '{current_model}'?"
        else: error_message += f" Détail: {e.error}"
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user': current_conversation_history.pop()
        return jsonify({"error": error_message}), 500
    except Exception as e:
        logging.error(f"Err chat: {e}", exc_info=True)
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user': current_conversation_history.pop()
        return jsonify({"error": "Err interne."}), 500

@app.route('/upload', methods=['POST'])
def upload_file():
    global uploaded_file_context, current_conversation_id
    if 'file' not in request.files: return jsonify({"error": "Aucun fichier."}), 400
    file = request.files['file']; filename = secure_filename(file.filename)
    if filename == '': return jsonify({"error": "Nom fichier vide."}), 400
    if not allowed_file(filename): return jsonify({"error": f"Type fichier non autorisé ({', '.join(ALLOWED_EXTENSIONS)})."}), 400
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    try:
        file.save(filepath); logging.info(f"Fich '{filename}' save: {filepath}")
        extracted_text = extract_text_from_file(filepath)
        if extracted_text is not None:
             if not current_conversation_id: start_new_chat_internal()
             uploaded_file_context[current_conversation_id] = {"filename": filename, "content": extracted_text}
             logging.info(f"Txt '{filename}' ({len(extracted_text)}c) stocké conv {current_conversation_id}.")
             return jsonify({"success": True,"message": f"'{filename}' upload/traité ({len(extracted_text)}c).","filename": filename})
        else: return jsonify({"error": f"'{filename}' upload mais échec extraction."}), 422
    except Exception as e: logging.error(f"Err upload/trait '{filename}': {e}", exc_info=True); return jsonify({"error": "Err serveur upload/trait."}), 500

def start_new_chat_internal():
    global current_conversation_history, current_conversation_id, uploaded_file_context
    if current_conversation_id in uploaded_file_context: del uploaded_file_context[current_conversation_id]
    current_conversation_id = str(uuid.uuid4()); current_conversation_history = []
    logging.info(f"Nouv conv démarrée: {current_conversation_id}")

@app.route('/new_chat', methods=['POST'])
def new_chat(): start_new_chat_internal(); return jsonify({"success": True, "message": "Nouv chat.", "conversation_id": current_conversation_id})

@app.route('/history', methods=['GET'])
def get_history_list():
    try:
        log_files = [f for f in os.listdir(LOG_FOLDER) if f.startswith("conversation_") and f.endswith(".json")]
        log_files.sort(key=lambda f: os.path.getmtime(os.path.join(LOG_FOLDER, f)), reverse=True)
        convs = [{"id": f.replace("conversation_","").replace(".json",""), "name": f"Chat du {datetime.fromtimestamp(os.path.getmtime(os.path.join(LOG_FOLDER, f))).strftime('%d/%m %H:%M')}"} for f in log_files]
        return jsonify({"conversations": convs})
    except Exception as e: logging.error(f"Err hist list: {e}", exc_info=True); return jsonify({"error": "Err list hist."}), 500

@app.route('/history/<conversation_id>', methods=['GET'])
def get_conversation(conversation_id):
    global current_conversation_history, current_conversation_id, uploaded_file_context
    try: uuid.UUID(conversation_id, version=4)
    except ValueError: return jsonify({"error": "ID conv invalide."}), 400
    history = load_log(conversation_id)
    if history:
        if current_conversation_id in uploaded_file_context: del uploaded_file_context[current_conversation_id]
        if conversation_id in uploaded_file_context: del uploaded_file_context[conversation_id]
        current_conversation_id = conversation_id; current_conversation_history = history
        logging.info(f"Conv {conversation_id} chargée log.")
        return jsonify({"id": conversation_id, "history": history, "file_context_status": "Ctx fichier non chargé."})
    else: logging.warning(f"Conv non trouvée log ID: {conversation_id}"); return jsonify({"error": "Conv non trouvée."}), 404


if __name__ == '__main__':
    print(f"--- Démarrage Serveur Flask ---"); print(f"Modèle Ollama par défaut: {current_model}")
    print(f"Accès via: http://127.0.0.1:5000"); print(f"---------------------------------")
    app.run(debug=True, host='127.0.0.1', port=5000)
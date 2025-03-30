import os
import ollama
import json
import uuid
from flask import Flask, request, jsonify, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime
import logging

# Configuration du logging
logging.basicConfig(level=logging.INFO)

# Configuration de Flask
app = Flask(__name__, static_folder='../frontend', static_url_path='')

# Configuration des dossiers
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uploads')
LOG_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
ALLOWED_EXTENSIONS = {'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'} # Ajout de txt pour simplicité

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(LOG_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['LOG_FOLDER'] = LOG_FOLDER

# --- État Global (Simplifié - Pourrait être amélioré avec des sessions utilisateur) ---
# Modèle Ollama par défaut ou sélectionné
current_model = 'deepseek-coder:1.3b' # Modèle par défaut au démarrage (petit pour test rapide)
# Historique de la conversation en cours (pour le contexte Ollama)
current_conversation_history = []
current_conversation_id = None

# --- Fonctions Utilitaires ---
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

# --- Routes de l'API ---

@app.route('/')
def index():
    # Sert la page HTML principale depuis le dossier frontend
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/set_model', methods=['POST'])
def set_model():
    global current_model
    data = request.json
    model_size = data.get('model_size')
    if model_size:
        # Construction du nom complet du modèle Deepseek
        # Attention: Vérifie si les modèles existent bien avec ce nom dans ton Ollama local
        # Ex: 'deepseek-coder:1.3b', 'deepseek-coder:6.7b', etc.
        # Adapte le préfixe 'deepseek-coder' si nécessaire (ex: 'deepseek-llm', 'deepseek-r1' etc.)
        # Le nom 'deepseek-r1:14b' suggéré dans la question semble spécifique. Utilisons un mapping.
        model_mapping = {
            "1.5b": "deepseek-coder:1.3b", # Ajuste ces noms selon tes modèles Ollama
            "7b": "deepseek-coder:6.7b",
            "8b": "deepseek-coder:???", # A vérifier/compléter
            "14b": "deepseek-coder:???", # A vérifier/compléter
            "32b": "deepseek-coder:33b", # Ajuste ces noms
            "70b": "deepseek-llm:67b", # Exemple, à ajuster
            "671b": "deepseek-???", # A vérifier/compléter
            # Ajoute le modèle 'deepseek-r1:14b' s'il existe sous ce nom exact
             "r1-14b": "deepseek-r1:14b" # Exemple basé sur ta commande
        }
        selected_model_name = model_mapping.get(model_size, f'deepseek-coder:{model_size}') # Fallback simple

        # Vérification si le modèle existe (peut ralentir un peu)
        try:
            ollama.show(selected_model_name) # Tente de récupérer les infos du modèle
            current_model = selected_model_name
            logging.info(f"Modèle changé pour : {current_model}")
            # Optionnel : Démarrer une nouvelle conversation lors du changement de modèle
            start_new_chat_internal()
            return jsonify({"success": True, "message": f"Modèle changé pour {current_model}. Nouvelle conversation démarrée.", "conversation_id": current_conversation_id})
        except ollama.ResponseError as e:
             logging.error(f"Erreur lors du changement de modèle pour '{selected_model_name}': {e}. Le modèle n'existe peut-être pas localement.")
             # Garde l'ancien modèle ou remet un défaut sûr
             # current_model = 'deepseek-coder:1.3b' # Remettre un défaut ?
             return jsonify({"success": False, "message": f"Modèle '{selected_model_name}' non trouvé ou invalide. Vérifiez les modèles disponibles dans Ollama."}), 400
    else:
        return jsonify({"success": False, "message": "Taille du modèle non fournie."}), 400

@app.route('/chat', methods=['POST'])
def chat():
    global current_conversation_history, current_conversation_id
    data = request.json
    user_input = data.get('message')

    if not user_input:
        return jsonify({"error": "Message vide reçu."}), 400

    if not current_conversation_id:
        start_new_chat_internal() # Assure qu'on a un ID

    # Ajoute le message utilisateur à l'historique actuel
    current_conversation_history.append({'role': 'user', 'content': user_input})

    logging.info(f"Envoi au modèle {current_model} avec l'historique (longueur: {len(current_conversation_history)})")
    logging.debug(f"Historique envoyé: {current_conversation_history}")

    try:
        # Appel à Ollama avec l'historique complet pour le contexte
        response = ollama.chat(
            model=current_model,
            messages=current_conversation_history,
            stream=False # Gardons simple pour l'instant (pas de streaming)
        )

        ai_response = response['message']['content']

        # Ajoute la réponse de l'IA à l'historique
        current_conversation_history.append({'role': 'assistant', 'content': ai_response})

        # Sauvegarde l'historique mis à jour dans le fichier log
        save_log(current_conversation_id, current_conversation_history)

        return jsonify({"response": ai_response})

    except ollama.ResponseError as e:
        logging.error(f"Erreur Ollama: {e}")
        # Essayer de retirer le dernier message utilisateur si l'appel échoue
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user':
             current_conversation_history.pop()
        return jsonify({"error": f"Erreur lors de la communication avec Ollama ({e.status_code}): {e.error}"}), 500
    except Exception as e:
        logging.error(f"Erreur inattendue: {e}")
        # Essayer de retirer le dernier message utilisateur
        if current_conversation_history and current_conversation_history[-1]['role'] == 'user':
             current_conversation_history.pop()
        return jsonify({"error": "Une erreur interne est survenue."}), 500


@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "Aucun fichier sélectionné"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "Nom de fichier vide"}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        try:
            file.save(filepath)
            logging.info(f"Fichier '{filename}' uploadé avec succès.")
            # NOTE : Ici, on ne fait QUE sauvegarder le fichier.
            # Pour l'utiliser, il faudrait :
            # 1. Extraire le texte (pdf, docx, etc.) avec les bibliothèques appropriées.
            # 2. Intégrer ce texte (ou un résumé) dans le prompt envoyé à Ollama.
            #    Cela pourrait être fait dans la route /chat en vérifiant si un fichier
            #    vient d'être uploadé ou en passant une référence au fichier.
            # Pour l'instant, on retourne juste un succès.
            return jsonify({
                "success": True,
                "message": f"Fichier '{filename}' uploadé.",
                "filename": filename
                # On pourrait retourner le chemin ou un ID si nécessaire
            })
        except Exception as e:
            logging.error(f"Erreur lors de la sauvegarde du fichier '{filename}': {e}")
            return jsonify({"error": "Erreur lors de la sauvegarde du fichier."}), 500
    else:
        return jsonify({"error": "Type de fichier non autorisé."}), 400

def start_new_chat_internal():
    """Fonction interne pour démarrer un nouveau chat."""
    global current_conversation_history, current_conversation_id
    current_conversation_id = str(uuid.uuid4()) # Génère un ID unique
    current_conversation_history = [] # Réinitialise l'historique en mémoire
    logging.info(f"Nouvelle conversation démarrée avec ID: {current_conversation_id}")
    # Pas besoin de sauvegarder un log vide immédiatement.

@app.route('/new_chat', methods=['POST'])
def new_chat():
    start_new_chat_internal()
    return jsonify({"success": True, "message": "Nouveau chat démarré.", "conversation_id": current_conversation_id})

@app.route('/history', methods=['GET'])
def get_history_list():
    try:
        log_files = [f for f in os.listdir(app.config['LOG_FOLDER']) if f.startswith("conversation_") and f.endswith(".json")]
        conversations = []
        for filename in sorted(log_files, reverse=True): # Trier par nom (date implicite si UUID/timestamp)
             conv_id = filename.replace("conversation_", "").replace(".json", "")
             # Essayer de lire la date de modification ou le premier message pour un meilleur tri/affichage
             try:
                 filepath = os.path.join(app.config['LOG_FOLDER'], filename)
                 mtime = os.path.getmtime(filepath)
                 dt_object = datetime.fromtimestamp(mtime)
                 # Charger juste le début pour un aperçu ?
                 # history_preview = load_log(conv_id)
                 # preview_text = history_preview[0]['content'][:50] + "..." if history_preview else "Conversation vide"
                 conversations.append({
                     "id": conv_id,
                     "name": f"Conv {dt_object.strftime('%Y-%m-%d %H:%M')}", # Nom basé sur la date
                     #"preview": preview_text
                 })
             except Exception as e:
                 logging.warning(f"Impossible de traiter le fichier log {filename}: {e}")
                 conversations.append({"id": conv_id, "name": f"Conversation {conv_id[:8]}..."}) # Fallback name

        return jsonify({"conversations": conversations})
    except Exception as e:
        logging.error(f"Erreur lors de la lecture de l'historique: {e}")
        return jsonify({"error": "Impossible de lire l'historique"}), 500

@app.route('/history/<conversation_id>', methods=['GET'])
def get_conversation(conversation_id):
    global current_conversation_history, current_conversation_id
    history = load_log(conversation_id)
    if history:
        # Définit cette conversation comme l'actuelle pour la reprise potentielle
        current_conversation_id = conversation_id
        current_conversation_history = history
        logging.info(f"Conversation {conversation_id} chargée.")
        return jsonify({"id": conversation_id, "history": history})
    else:
        return jsonify({"error": "Conversation non trouvée."}), 404

if __name__ == '__main__':
    # Note: Utiliser host='0.0.0.0' rend le serveur accessible depuis d'autres machines sur le réseau.
    # Pour un usage strictement local, '127.0.0.1' suffit.
    app.run(debug=True, host='127.0.0.1', port=5000) # debug=True pour le développement
// frontend/script.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Références aux éléments DOM ---
    const chatWindow = document.getElementById('chat-window');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const historyList = document.getElementById('history-list');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const dropZone = document.getElementById('drop-zone');
    const statusBar = document.getElementById('status-bar');
    const modelBaseSelect = document.getElementById('model-base-select'); // Nouveau select base
    const modelTagSelect = document.getElementById('model-tag-select');   // Nouveau select tag

    // --- Variables d'état ---
    let currentConversationId = null;
    let availableModels = {}; // Stocke {base: [tags]} reçus du backend
    let currentBackendModel = ''; // Stocke le nom complet du modèle actif côté backend

    // --- Configuration de Marked.js ---
    // Assurez-vous d'inclure marked.min.js dans votre HTML avant ce script
    if (typeof marked === 'undefined') {
        console.error("La bibliothèque Marked.js n'est pas chargée. Le rendu Markdown ne fonctionnera pas.");
        // Optionnel: Afficher une erreur à l'utilisateur
        addMessage('system', "Erreur : Impossible de charger le moteur Markdown.", 'error');
    } else {
        marked.setOptions({
            breaks: true, // Convertit les sauts de ligne simples en <br>
            gfm: true,    // Active GitHub Flavored Markdown (tableaux, etc.)
            // Pour la sécurité, envisagez d'ajouter un sanitizer comme DOMPurify si nécessaire
            // sanitizer: (html) => DOMPurify.sanitize(html), // Nécessite d'inclure DOMPurify
        });
    }


    // --- Fonctions Utilitaires ---

    /**
     * Ajoute un message à la fenêtre de chat.
     * Gère le rendu Markdown pour l'assistant et l'affichage conditionnel de la "pensée".
     * Échappe le HTML pour les messages utilisateur et système.
     * @param {string} sender 'user', 'assistant', ou 'system'
     * @param {string|object} data Le contenu du message. Pour l'assistant, peut être {visible_response, thinking_process}.
     * @param {string} type Type de message ('normal' ou 'error')
     */
    function addMessage(sender, data, type = 'normal') {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender);
        if (type === 'error') {
            messageElement.classList.add('error');
            messageElement.classList.remove(sender); // Un message d'erreur n'a pas de "rôle" user/assistant
        }

        const messageContentDiv = document.createElement('div');
        messageContentDiv.classList.add('message-content');

        let visibleText = '';
        let thinkingText = '';

        // Détermine le contenu visible et la pensée en fonction du type de message
        if (sender === 'assistant' && typeof data === 'object') {
            // C'est la réponse structurée {visible_response, thinking_process}
            visibleText = data.visible_response || '';
            thinkingText = data.thinking_process || '';
            // Rendu Markdown pour la partie visible
            try {
                 messageContentDiv.innerHTML = marked.parse(visibleText);
            } catch (e) {
                 console.error("Erreur lors du parsing Markdown:", e);
                 messageContentDiv.textContent = visibleText; // Fallback en texte brut
            }
        } else {
            // Message utilisateur, système (y compris erreur système)
             // Utilise textContent pour échapper le HTML potentiel
             const textData = (typeof data === 'object' ? JSON.stringify(data) : String(data)); // Assure que c'est une chaîne
             const tempDiv = document.createElement('div');
             tempDiv.textContent = textData;
             messageContentDiv.innerHTML = tempDiv.innerHTML;
        }

        messageElement.appendChild(messageContentDiv);

        // Ajoute le bouton et la div 'think' si nécessaire
        if (sender === 'assistant' && thinkingText) {
            const thinkContainer = document.createElement('div');
            thinkContainer.classList.add('thinking-content'); // Caché par CSS par défaut

            // Échappe le HTML potentiel dans le thinking text
            const thinkTempDiv = document.createElement('div');
            thinkTempDiv.textContent = thinkingText;
            thinkContainer.innerHTML = thinkTempDiv.innerHTML; // Affiche contenu brut échappé

            const toggleButton = document.createElement('button');
            toggleButton.classList.add('toggle-think-button');
            toggleButton.textContent = '🤔 Voir la réflexion';
            toggleButton.setAttribute('aria-expanded', 'false'); // Pour l'accessibilité
            toggleButton.onclick = () => {
                const isVisible = thinkContainer.classList.toggle('visible');
                toggleButton.textContent = isVisible ? '🤔 Cacher la réflexion' : '🤔 Voir la réflexion';
                toggleButton.setAttribute('aria-expanded', isVisible);
            };

            messageElement.appendChild(toggleButton);
            messageElement.appendChild(thinkContainer);
        }

        chatWindow.appendChild(messageElement);
        // Scroll vers le bas pour voir le nouveau message
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    /**
     * Met à jour le message dans la barre de statut.
     * @param {string} message Le message à afficher.
     * @param {boolean} isError Si true, applique un style d'erreur.
     */
    function setStatus(message, isError = false) {
        statusBar.textContent = message;
        statusBar.style.color = isError ? '#721c24' : '#6c757d';
        statusBar.style.backgroundColor = isError ? '#f8d7da' : '#e9ecef';
    }

    /**
     * Active/désactive les contrôles de l'interface pendant le chargement.
     * @param {boolean} isLoading True pour désactiver les contrôles, false pour les réactiver.
     */
    function setLoading(isLoading) {
         sendBtn.disabled = isLoading;
         messageInput.disabled = isLoading;
         uploadBtn.disabled = isLoading;
         modelBaseSelect.disabled = isLoading;
         modelTagSelect.disabled = isLoading || modelTagSelect.length <= 1; // Garde désactivé s'il est vide/placeholder
         newChatBtn.disabled = isLoading; // Désactive aussi "Nouveau Chat"

         // Style visuel pour indiquer le chargement
         const opacity = isLoading ? 0.6 : 1;
         const pointerEvents = isLoading ? 'none' : 'auto';
         [messageInput, sendBtn, uploadBtn, modelBaseSelect, modelTagSelect, newChatBtn, dropZone].forEach(el => {
             if(el) { // Vérifie si l'élément existe
                 el.style.opacity = opacity;
                 el.style.pointerEvents = pointerEvents;
             }
         });

         setStatus(isLoading ? "Traitement en cours..." : "Prêt.");
    }

    // --- Gestion des Modèles ---

    /**
     * Remplit le dropdown des tags basé sur le modèle de base sélectionné.
     * @param {string} baseModelName Le nom du modèle de base sélectionné.
     */
    function populateTagSelect(baseModelName) {
        modelTagSelect.innerHTML = ''; // Vide complètement
        modelTagSelect.disabled = true; // Désactive par défaut

        if (baseModelName && availableModels[baseModelName]) {
            // Ajoute une option placeholder
            const placeholderOption = document.createElement('option');
            placeholderOption.value = "";
            placeholderOption.textContent = "Choisir tag/taille...";
            placeholderOption.disabled = true;
            placeholderOption.selected = true;
            modelTagSelect.appendChild(placeholderOption);

            // Ajoute les tags disponibles
            availableModels[baseModelName].forEach(tag => {
                const option = document.createElement('option');
                option.value = tag;
                option.textContent = tag;
                modelTagSelect.appendChild(option);
            });
            modelTagSelect.disabled = false; // Réactive si des tags existent

             // Tente de pré-sélectionner le tag du modèle par défaut/actuel
            if (currentBackendModel && currentBackendModel.startsWith(baseModelName + ":")) {
                const defaultTag = currentBackendModel.split(':')[1];
                 if (availableModels[baseModelName].includes(defaultTag)) {
                    modelTagSelect.value = defaultTag; // Sélectionne le tag
                 }
            }

        } else {
            // Si aucune base sélectionnée ou pas de tags trouvés
             const option = document.createElement('option');
             option.value = "";
             option.textContent = "Choisir modèle d'abord";
             option.disabled = true;
             option.selected = true;
             modelTagSelect.appendChild(option);
        }
    }

    /**
     * Charge la liste des modèles disponibles depuis le backend et peuple les dropdowns.
     */
    async function loadModels() {
        setStatus("Chargement des modèles...");
        setLoading(true); // Désactive l'interface pendant le chargement initial des modèles
        try {
            const response = await fetch('/api/models');
            if (!response.ok) {
                const errorText = await response.text(); // Lire le corps pour plus de détails
                throw new Error(`Erreur ${response.status}: ${errorText || response.statusText}`);
            }
            const data = await response.json();
            if (data.error) { // Gère erreur JSON renvoyée par le backend
                throw new Error(data.error);
            }

            availableModels = data.models || {};
            currentBackendModel = data.default_model || ''; // Modèle par défaut/actuel du backend

            // Peuple le select de base
            modelBaseSelect.innerHTML = ''; // Vide
            const placeholderBase = document.createElement('option');
            placeholderBase.value = ""; placeholderBase.textContent = "Choisir modèle...";
            placeholderBase.disabled = true; placeholderBase.selected = true;
            modelBaseSelect.appendChild(placeholderBase);

            const baseNames = Object.keys(availableModels).sort();
            if (baseNames.length === 0) {
                 setStatus("Aucun modèle Ollama trouvé !", true);
                 addMessage('system', "Aucun modèle n'a été trouvé sur le serveur Ollama. Vérifiez que Ollama est lancé et que des modèles sont installés.", 'error');
                 return; // Bloque ici si aucun modèle
            }
            baseNames.forEach(baseName => {
                const option = document.createElement('option');
                option.value = baseName; option.textContent = baseName;
                modelBaseSelect.appendChild(option);
            });

            // Pré-sélectionne le modèle par défaut/actuel
            let baseToSelect = '';
            if (currentBackendModel && currentBackendModel.includes(':')) {
                const defaultBase = currentBackendModel.split(':')[0];
                if (availableModels[defaultBase]) {
                     modelBaseSelect.value = defaultBase;
                     baseToSelect = defaultBase; // Base à utiliser pour peupler les tags
                }
            }
            populateTagSelect(baseToSelect); // Peuple les tags pour la base sélectionnée (ou vide si aucune)

            setStatus("Prêt."); // Statut final après chargement réussi

        } catch (error) {
            console.error("Erreur chargement modèles:", error);
            setStatus(`Erreur modèles: ${error.message}`, true);
            modelBaseSelect.innerHTML = '<option value="" disabled selected>Erreur</option>';
            modelTagSelect.innerHTML = '<option value="" disabled selected>-</option>';
            addMessage('system', `Erreur chargement modèles: ${error.message}`, 'error');
        } finally {
            setLoading(false); // Réactive l'interface
             // Assure que le select de base est réactivé même en cas d'erreur (sauf si aucun modèle)
             if (Object.keys(availableModels).length > 0) {
                  modelBaseSelect.disabled = false;
              }
        }
    }

    /**
     * Appelle le backend pour définir le nouveau modèle sélectionné.
     */
    async function setModel() {
        const selectedBase = modelBaseSelect.value;
        const selectedTag = modelTagSelect.value;

        if (!selectedBase || !selectedTag) return; // Ne fait rien si la sélection n'est pas complète

        const fullModelName = `${selectedBase}:${selectedTag}`;
        if (fullModelName === currentBackendModel) {
             setStatus(`Modèle ${fullModelName} déjà actif.`);
             return;
         }

        setStatus(`Changement vers ${fullModelName}...`);
        setLoading(true);
        try {
            const response = await fetch('/set_model', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ base_model: selectedBase, tag: selectedTag }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                 throw new Error(data.message || `Erreur HTTP ${response.status}`);
            }
             // Succès
             setStatus(data.message);
             chatWindow.innerHTML = '';
             addMessage('assistant', { visible_response: "Nouvelle conversation démarrée.", thinking_process: '' });
             currentConversationId = data.conversation_id;
             currentBackendModel = fullModelName; // Mise à jour état local
             await loadHistoryList(); // Rafraîchit la liste (même si vide)

        } catch (error) {
             console.error("Erreur définition modèle:", error);
             addMessage('system', `Erreur changement modèle: ${error.message}`, 'error');
             setStatus(`Erreur: ${error.message}`, true);
             // Optionnel : Revenir à la sélection précédente ?
             // Pour l'instant on laisse les selects tels quels mais on signale l'erreur.
             // Il faut peut-être rafraîchir l'état 'currentBackendModel' si le changement a échoué
             // loadModels(); // Recharger pour resynchroniser? Pourrait être lourd.
        } finally {
            setLoading(false);
        }
    }

    // --- Gestion du Chat ---

    /**
     * Envoie le message de l'utilisateur au backend et affiche la réponse.
     */
    async function sendMessage() {
        const messageText = messageInput.value.trim();
        if (!messageText || sendBtn.disabled) return; // Ne pas envoyer si vide ou si déjà en chargement

        addMessage('user', messageText);
        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height

        setLoading(true);

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageText }),
            });

            const contentType = response.headers.get("content-type");
            let data;
            if (contentType && contentType.includes("application/json")) {
                data = await response.json();
            } else {
                const textResponse = await response.text();
                throw new Error(`Réponse serveur non-JSON: ${response.status} ${textResponse}`);
            }

            if (!response.ok) {
                throw new Error(data.error || `Erreur HTTP: ${response.status}`);
            }

            // Gestion robuste de la réponse (format nouveau ou ancien)
            let visibleText = ''; let thinkingText = '';
             if (data.visible_response !== undefined || data.thinking_process !== undefined) {
                visibleText = data.visible_response || ''; thinkingText = data.thinking_process || '';
             } else if (data.response) { // Fallback pour l'ancien format juste 'response'
                 console.warn("Réception ancien format {response}, séparation côté client.");
                 const thinkMatch = data.response.match(/<think>([\s\S]*?)<\/think>/i);
                 if (thinkMatch && thinkMatch[1]) {
                     thinkingText = thinkMatch[1].trim();
                     visibleText = data.response.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
                 } else { visibleText = data.response.trim(); }
            } else { throw new Error("Format de réponse IA non reconnu."); }

            addMessage('assistant', { visible_response: visibleText, thinking_process: thinkingText });

        } catch (error) {
            console.error("Erreur chat:", error);
            addMessage('system', `Erreur: ${error.message}`, 'error');
            setStatus(`Erreur: ${error.message}`, true);
        } finally {
            setLoading(false);
            messageInput.focus(); // Remet le focus sur l'input
        }
    }

    // --- Gestion de l'Historique ---

    /**
     * Démarre une nouvelle conversation.
     */
    async function startNewChat() {
        if (newChatBtn.disabled) return; // Evite double clic
        setStatus("Démarrage nouveau chat...");
        setLoading(true);
        try {
             const response = await fetch('/new_chat', { method: 'POST' });
             const data = await response.json();
             if (!response.ok || !data.success) {
                 throw new Error(data.message || "Erreur serveur nouveau chat.");
             }
             chatWindow.innerHTML = '';
             addMessage('assistant', { visible_response: 'Nouvelle conversation démarrée.', thinking_process: '' });
             messageInput.value = '';
             currentConversationId = data.conversation_id;
             setStatus('Nouveau chat prêt.');
             await loadHistoryList(); // Met à jour la liste (potentiellement inutile mais cohérent)
        } catch (error) {
             console.error("Erreur nouveau chat:", error);
             addMessage('system', `Erreur: ${error.message}`, 'error');
             setStatus(`Erreur: ${error.message}`, true);
        } finally { setLoading(false); }
    }

    /**
     * Charge la liste des conversations sauvegardées dans la sidebar.
     */
    async function loadHistoryList() {
        historyList.innerHTML = '<li class="loading">Chargement historique...</li>';
        try {
            const response = await fetch('/history');
            if (!response.ok) throw new Error(`Erreur ${response.status}`);
            const data = await response.json();
             if (data.error) throw new Error(data.error);

            historyList.innerHTML = ''; // Vide la liste
            if (data.conversations && data.conversations.length > 0) {
                data.conversations.forEach(conv => {
                    const li = document.createElement('li');
                    li.textContent = conv.name; // Utilise le nom formaté du backend
                    li.dataset.id = conv.id;
                    li.title = `Charger la conversation ${conv.id}`; // Tooltip
                    li.addEventListener('click', () => loadConversation(conv.id));
                    historyList.appendChild(li);
                });
            } else {
                historyList.innerHTML = '<li>Aucun historique.</li>';
            }
        } catch (error) {
             console.error("Erreur chargement historique:", error);
             historyList.innerHTML = '<li>Erreur chargement.</li>';
             // Ne pas mettre en statut d'erreur bloquant ici, juste loguer
        }
    }

    /**
     * Charge le contenu d'une conversation spécifique depuis l'historique.
     * @param {string} conversationId L'ID de la conversation à charger.
     */
    async function loadConversation(conversationId) {
        // Évite de recharger si c'est déjà la conversation active
        if (conversationId === currentConversationId && chatWindow.children.length > 1) {
             setStatus("Conversation déjà chargée."); return;
         }
         const shortId = conversationId.substring(0, 8);
         setStatus(`Chargement conv ${shortId}...`);
         setLoading(true);
         try {
            const response = await fetch(`/history/${conversationId}`);
            if (!response.ok) {
                 const errorData = await response.json().catch(()=>({error: `Erreur ${response.status}`}));
                 throw new Error(errorData.error || `Erreur chargement conversation.`);
            }
            const data = await response.json();
             if (data.error) throw new Error(data.error);

            chatWindow.innerHTML = ''; // Vide fenêtre
            if (data.history && data.history.length > 0) {
                 data.history.forEach(message => {
                     if (message.role === 'user') {
                        addMessage(message.role, message.content);
                     } else { // assistant
                         addMessage(message.role, { visible_response: message.content, thinking_process: '' });
                     }
                 });
                 currentConversationId = data.id;
                 setStatus(`Conv ${shortId} chargée. ${data.file_context_status || ''}`);
             } else {
                 addMessage('assistant', { visible_response: 'Conversation vide ou erreur chargement.', thinking_process: '' });
                 currentConversationId = data.id; // Met quand même à jour l'ID
                 setStatus(`Conv ${shortId} chargée (vide).`);
             }
             // Rafraichir la liste n'est pas nécessaire ici, sauf si le nom a changé
             // await loadHistoryList();
        } catch (error) {
             console.error(`Erreur chargement conv ${conversationId}:`, error);
             addMessage('system', `Erreur chargement: ${error.message}`, 'error');
             setStatus(`Erreur chargement: ${error.message}`, true);
        } finally { setLoading(false); }
    }

    // --- Gestion Upload Fichiers ---

    /**
     * Gère les fichiers sélectionnés ou déposés.
     * @param {FileList} files La liste des fichiers.
     */
    function handleFiles(files) {
         if (!files || files.length === 0 || uploadBtn.disabled) return;
         const file = files[0]; // Gère un seul fichier pour l'instant

         // Validation type/extension (un peu redondant avec le backend mais UX)
         const allowedExtensions = /\.(pdf|docx|xlsx|txt)$/i;
          if (!allowedExtensions.test(file.name) ) {
              const msg = `Type fichier non supporté: ${file.name}`;
              setStatus(msg, true);
              addMessage('system', msg + ". Types: PDF, DOCX, XLSX, TXT.", 'error');
              fileInput.value = null; return;
          }

         const formData = new FormData();
         formData.append('file', file);
         setStatus(`Upload de ${file.name}...`);
         setLoading(true);

          fetch('/upload', { method: 'POST', body: formData })
            .then(response => { // Gestion améliorée de la réponse
                 return response.json().then(data => { // Suppose que c'est toujours JSON
                     if (!response.ok) { throw new Error(data.error || `Erreur serveur ${response.status}`); }
                     return data; // Renvoie les données si OK
                 });
             })
            .then(data => { // data contient {success, message, filename} ou a levé une erreur
                 if (data.success) {
                     setStatus(data.message);
                     addMessage('system', data.message);
                 } else { // Ne devrait pas arriver si !response.ok lève une erreur, mais sécurité
                     throw new Error(data.error || "Erreur inconnue lors de l'upload.");
                 }
            })
            .catch(error => {
                console.error("Erreur upload/traitement:", error);
                 addMessage('system', `Erreur upload : ${error.message}`, 'error');
                 setStatus(`Erreur upload: ${error.message}`, true);
            })
             .finally(() => {
                 setLoading(false);
                 fileInput.value = null; // Réinitialise l'input fichier
             });
    }


    // --- Écouteurs d'Événements ---
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    messageInput.addEventListener('input', () => { messageInput.style.height = 'auto'; messageInput.style.height = (messageInput.scrollHeight) + 'px'; });
    newChatBtn.addEventListener('click', startNewChat);
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    // Drag & Drop
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); if (!dropZone.style.pointerEvents || dropZone.style.pointerEvents === 'auto') dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.classList.remove('dragover');
        if (e.dataTransfer.files && (!dropZone.style.pointerEvents || dropZone.style.pointerEvents === 'auto')) {
            handleFiles(e.dataTransfer.files);
        }
    });

    // Écouteurs pour les selects de modèle
    modelBaseSelect.addEventListener('change', (e) => {
        populateTagSelect(e.target.value);
        // Réinitialise le tag sélectionné quand la base change
        modelTagSelect.value = "";
        // Pas d'appel à setModel() ici, on attend le choix du tag
    });
    modelTagSelect.addEventListener('change', () => {
        setModel(); // Déclenche le changement quand un tag est sélectionné
    });

    // --- Initialisation ---
    loadHistoryList(); // Charger l'historique des conversations
    loadModels();      // Charger les modèles disponibles et configurer les selects

}); // Fin de DOMContentLoaded
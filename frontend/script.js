document.addEventListener('DOMContentLoaded', () => {
    const chatWindow = document.getElementById('chat-window');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const modelSelect = document.getElementById('model-select');
    const historyList = document.getElementById('history-list');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const dropZone = document.getElementById('drop-zone');
    const statusBar = document.getElementById('status-bar');

    let currentConversationId = null;

    // Configurer Marked.js (Optionnel mais bonne pratique)
    // Si tu as ajouté DOMPurify: marked.use({ sanitizer: DOMPurify.sanitize });
    // Sinon, utilise les options de base de marked
    marked.setOptions({
      breaks: true, // Convertit les sauts de ligne simples en <br>
      gfm: true,    // Active GitHub Flavored Markdown (tableaux, etc.)
      // Attention: Le sanitizer intégré de marked est basique.
      // Pour une sécurité accrue si l'origine du markdown est incertaine:
      // sanitize: true, // DEPRECATED in newer versions, might remove basic html
      // Consider using DOMPurify if available and needed:
      // sanitizer: (html) => DOMPurify.sanitize(html),
    });


    // --- Fonctions Utilitaires ---

    // MODIFIÉ: addMessage pour gérer le Markdown et potentiellement le bouton/contenu 'think'
    function addMessage(sender, data, type = 'normal') {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender);
        if (type === 'error') {
            messageElement.classList.add('error');
            messageElement.classList.remove(sender); // Error n'est ni user ni assistant
        }

        const messageContentDiv = document.createElement('div');
        messageContentDiv.classList.add('message-content');

        let visibleText = '';
        let thinkingText = '';

        if (sender === 'assistant' && typeof data === 'object') {
            // C'est la réponse structurée du backend
            visibleText = data.visible_response || ''; // Prend la partie visible
            thinkingText = data.thinking_process || ''; // Prend la partie pensée
            // Convertir le texte VISIBLE en HTML via Marked.js
            messageContentDiv.innerHTML = marked.parse(visibleText);
        } else if (sender === 'system' && type === 'error') {
            // Message d'erreur système (texte simple)
             messageContentDiv.textContent = data; // Utilise textContent pour éviter interprétation HTML
        }
        else {
            // Message utilisateur ou système normal (texte simple)
             // Échapper le HTML potentiel dans les messages utilisateur avant de l'afficher
             const tempDiv = document.createElement('div');
             tempDiv.textContent = data;
             messageContentDiv.innerHTML = tempDiv.innerHTML; // Récupère le texte échappé
        }

        messageElement.appendChild(messageContentDiv);

        // Ajoute le bouton et la div 'think' si nécessaire (pour l'assistant ET si thinkingText existe)
        if (sender === 'assistant' && thinkingText) {
            const thinkContainer = document.createElement('div');
            thinkContainer.classList.add('thinking-content'); // Caché par défaut par CSS
            // Échapper le HTML potentiel dans le thinking text avant de l'afficher
             const thinkTempDiv = document.createElement('div');
             thinkTempDiv.textContent = thinkingText;
            thinkContainer.innerHTML = thinkTempDiv.innerHTML; // Affiche le contenu brut échappé

            const toggleButton = document.createElement('button');
            toggleButton.classList.add('toggle-think-button');
            toggleButton.textContent = '🤔 Voir la réflexion';
            toggleButton.onclick = () => {
                const isVisible = thinkContainer.classList.toggle('visible');
                toggleButton.textContent = isVisible ? '🤔 Cacher la réflexion' : '🤔 Voir la réflexion';
            };

            messageElement.appendChild(toggleButton); // Ajoute le bouton après le contenu principal
            messageElement.appendChild(thinkContainer); // Ajoute la div pensée après le bouton
        }


        chatWindow.appendChild(messageElement);
        chatWindow.scrollTop = chatWindow.scrollHeight; // Scroll vers le bas
    }

    function setStatus(message, isError = false) {
        statusBar.textContent = message;
        statusBar.style.color = isError ? '#721c24' : '#6c757d';
        statusBar.style.backgroundColor = isError ? '#f8d7da' : '#e9ecef';
    }

    function setLoading(isLoading) {
         sendBtn.disabled = isLoading;
         messageInput.disabled = isLoading;
         uploadBtn.disabled = isLoading; // Désactiver aussi l'upload
         // Idéalement, désactiver aussi le drag-drop visuellement
         dropZone.style.opacity = isLoading ? 0.5 : 1;
         dropZone.style.pointerEvents = isLoading ? 'none' : 'auto';

         if(isLoading) {
             setStatus("L'IA réfléchit...");
             // Optionnel: ajouter un indicateur visuel de chargement dans la fenêtre de chat
             // addTypingIndicator();
         } else {
             setStatus("Prêt.");
             // Optionnel: supprimer l'indicateur de chargement
             // removeTypingIndicator();
         }
    }

    // --- Gestion du Chat ---
    async function sendMessage() {
        const messageText = messageInput.value.trim();
        if (!messageText) return;

        // Utilise la fonction addMessage qui gère l'échappement HTML pour l'utilisateur
        addMessage('user', messageText);
        messageInput.value = '';
        messageInput.style.height = 'auto';

        setLoading(true);

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageText }),
            });

            // Vérifier si la réponse est bien du JSON avant de la parser
            const contentType = response.headers.get("content-type");
            let data;
            if (contentType && contentType.includes("application/json")) {
                data = await response.json();
            } else {
                // Si ce n'est pas du JSON, lire comme texte pour afficher l'erreur serveur brute
                const textResponse = await response.text();
                throw new Error(`Réponse inattendue du serveur (non-JSON): ${response.status} ${response.statusText} - ${textResponse}`);
            }


            if (!response.ok) {
                 // Utiliser l'erreur du JSON si disponible, sinon l'erreur HTTP
                throw new Error(data.error || `Erreur HTTP: ${response.status} ${response.statusText}`);
            }

            // *** MODIFIÉ: Passer l'objet {visible_response, thinking_process} à addMessage ***
            addMessage('assistant', {
                visible_response: data.visible_response,
                thinking_process: data.thinking_process
            });

        } catch (error) {
            console.error("Erreur lors de l'envoi/réception du message:", error);
            // Affiche l'erreur dans le chat en utilisant addMessage
            addMessage('system', `Erreur: ${error.message}`, 'error');
            setStatus(`Erreur: ${error.message}`, true);
        } finally {
            setLoading(false);
            messageInput.focus();
        }
    }

    // --- Gestion Modèle, Historique, Upload (Restent majoritairement identiques) ---

    async function changeModel() {
        const selectedModelSize = modelSelect.value;
        setStatus(`Changement modèle vers ${selectedModelSize}...`);
        setLoading(true);
        try {
            const response = await fetch('/set_model', { /* ... */ }); // Pas de changement ici
            const data = await response.json();
             if (response.ok && data.success) {
                 setStatus(data.message || `Modèle changé. Nouvelle conversation démarrée.`);
                 chatWindow.innerHTML = '';
                 addMessage('assistant', { visible_response: "Nouvelle conversation démarrée avec le modèle sélectionné.", thinking_process: "" }); // Nouvelle signature
                 currentConversationId = data.conversation_id;
                 await loadHistoryList();
             } else {
                 throw new Error(data.message || "Erreur changement modèle.");
             }
        } catch (error) {
             console.error("Erreur changement modèle:", error);
             addMessage('system', `Erreur changement modèle: ${error.message}`, 'error');
             setStatus(`Erreur: ${error.message}`, true);
        } finally { setLoading(false); }
    }

    async function startNewChat() {
        setStatus("Démarrage nouveau chat...");
        setLoading(true);
        try {
             const response = await fetch('/new_chat', { method: 'POST' }); // Pas de changement ici
             const data = await response.json();
             if (response.ok && data.success) {
                chatWindow.innerHTML = '';
                // Utilise la nouvelle structure même pour les messages système simples
                addMessage('assistant', { visible_response: 'Nouvelle conversation démarrée.', thinking_process: '' });
                messageInput.value = '';
                currentConversationId = data.conversation_id;
                setStatus('Nouveau chat prêt.');
                await loadHistoryList();
             } else {
                 throw new Error(data.message || "Impossible démarrer nouveau chat.");
             }
        } catch (error) {
             console.error("Erreur nouveau chat:", error);
             addMessage('system', `Erreur: ${error.message}`, 'error');
             setStatus(`Erreur: ${error.message}`, true);
        } finally { setLoading(false); }
    }

    async function loadHistoryList() {
        historyList.innerHTML = '<li class="loading">Chargement historique...</li>';
        try {
            const response = await fetch('/history'); // Pas de changement ici
            if (!response.ok) throw new Error(`Erreur HTTP: ${response.status}`);
            const data = await response.json();
            historyList.innerHTML = '';
             if (data.conversations && data.conversations.length > 0) {
                data.conversations.forEach(conv => {
                    const li = document.createElement('li');
                    li.textContent = conv.name || `Conversation ${conv.id.substring(0, 8)}`;
                    li.dataset.id = conv.id;
                    li.addEventListener('click', () => loadConversation(conv.id));
                    historyList.appendChild(li);
                });
            } else {
                historyList.innerHTML = '<li>Aucun historique.</li>';
            }
        } catch (error) {
             console.error("Erreur chargement historique:", error);
             historyList.innerHTML = '<li>Erreur chargement historique.</li>';
             setStatus(`Erreur historique: ${error.message}`, true);
        }
    }

    async function loadConversation(conversationId) {
        if (conversationId === currentConversationId && chatWindow.children.length > 1) {
             setStatus("Conversation déjà chargée."); return;
         }
         setStatus(`Chargement conversation ${conversationId.substring(0, 8)}...`);
         setLoading(true);
         try {
            const response = await fetch(`/history/${conversationId}`); // Pas de changement ici
            if (!response.ok) {
                 const errorData = await response.json();
                 throw new Error(errorData.error || `Erreur HTTP: ${response.status}`);
            }
            const data = await response.json();
            chatWindow.innerHTML = '';
             if (data.history && data.history.length > 0) {
                 data.history.forEach(message => {
                     // *** MODIFIÉ: Recrée la structure pour addMessage ***
                     // L'historique ne contient que la partie visible. 'thinking' sera vide.
                     if (message.role === 'user') {
                        addMessage(message.role, message.content);
                     } else { // assistant
                         addMessage(message.role, { visible_response: message.content, thinking_process: '' });
                     }
                 });
                currentConversationId = data.id;
                setStatus(`Conversation ${conversationId.substring(0, 8)} chargée. ${data.file_context_status || ''}`);
             } else {
                 addMessage('assistant', { visible_response: 'Conversation vide ou erreur chargement.', thinking_process: '' });
                 currentConversationId = data.id;
                 setStatus(`Conversation ${conversationId.substring(0, 8)} chargée (vide).`);
             }
             await loadHistoryList();
        } catch (error) {
             console.error(`Erreur chargement conv ${conversationId}:`, error);
             addMessage('system', `Erreur chargement: ${error.message}`, 'error');
             setStatus(`Erreur chargement: ${error.message}`, true);
        } finally { setLoading(false); }
    }

     function handleFiles(files) {
         if (files.length === 0) return;
         const file = files[0];
         const allowedMimeTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
         const allowedExtensions = /\.(pdf|docx|xlsx|txt)$/i;

          if (!allowedMimeTypes.includes(file.type) && !file.name.match(allowedExtensions) ) {
              const msg = `Type fichier non supporté: ${file.name}`;
              setStatus(msg, true);
              addMessage('system', msg + ". Types: PDF, DOCX, XLSX, TXT.", 'error');
              fileInput.value = null; // Reset input
              return;
          }

         const formData = new FormData();
         formData.append('file', file);
         setStatus(`Upload de ${file.name}...`);
         setLoading(true);

          fetch('/upload', { method: 'POST', body: formData }) // Pas de changement ici
            .then(response => {
                 const contentType = response.headers.get("content-type");
                 if (contentType && contentType.includes("application/json")) {
                     return response.json().then(data => ({ ok: response.ok, status: response.status, data }));
                 } else {
                     return response.text().then(text => { throw new Error(`Réponse serveur inattendue: ${text}`) });
                 }
             })
            .then(({ ok, status, data }) => {
                if (ok && data.success) {
                    setStatus(data.message);
                    addMessage('system', data.message); // Utilise le message du backend
                } else {
                    throw new Error(data.error || `Erreur serveur ${status}`);
                }
            })
            .catch(error => {
                console.error("Erreur upload/traitement:", error);
                 addMessage('system', `Erreur upload/traitement : ${error.message}`, 'error');
                 setStatus(`Erreur: ${error.message}`, true);
            })
             .finally(() => {
                 setLoading(false);
                 fileInput.value = null;
             });
    }


    // --- Écouteurs d'Événements (Setup initial) ---
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = (messageInput.scrollHeight) + 'px';
    });
    newChatBtn.addEventListener('click', startNewChat);
    modelSelect.addEventListener('change', changeModel);
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    // Drag & Drop
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.classList.remove('dragover');
        if (e.dataTransfer.files) { handleFiles(e.dataTransfer.files); }
    });

    // --- Initialisation ---
    loadHistoryList();
    setStatus("Prêt."); // Statut initial
    // Optionnel: Démarre un nouveau chat au chargement si aucune conversation n'est active
    // setTimeout(() => { if (!currentConversationId) startNewChat(); }, 500);

}); // Fin de DOMContentLoaded
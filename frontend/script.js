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

    let currentConversationId = null; // Garde une trace de l'ID côté client aussi

    // --- Fonctions Utilitaires ---
    function addMessage(sender, text, type = 'normal') {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender); // 'user' or 'assistant'
         if (type === 'error') {
             messageElement.classList.add('error');
             messageElement.classList.remove(sender); // Error n'est ni user ni assistant
         }
        // Simple conversion markdown basique (gras, italique, code inline)
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Gras
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');     // Italique
        text = text.replace(/`(.*?)`/g, '<code>$1</code>');   // Code inline
        // Convertir les blocs de code ```lang\ncode\n``` en <pre><code>
        text = text.replace(/```(\w+)?\n([\s\S]*?)\n```/g, (match, lang, code) => {
            const languageClass = lang ? ` class="language-${lang}"` : '';
            // Basic HTML escaping for code blocks
            code = code.replace(/</g, "<").replace(/>/g, ">");
            return `<pre><code${languageClass}>${code.trim()}</code></pre>`;
        });
         // Convertir les nouvelles lignes en <br> pour l'affichage HTML
        text = text.replace(/\n/g, '<br>');
        messageElement.innerHTML = text; // Use innerHTML because we added HTML elements

        chatWindow.appendChild(messageElement);
        // Scroll vers le bas automatiquement
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    function setStatus(message, isError = false) {
        statusBar.textContent = message;
        statusBar.style.color = isError ? '#721c24' : '#6c757d';
        statusBar.style.backgroundColor = isError ? '#f8d7da' : '#e9ecef';
    }

    function setLoading(isLoading) {
         sendBtn.disabled = isLoading;
         messageInput.disabled = isLoading;
         if(isLoading) {
             setStatus("L'IA réfléchit...");
         } else {
             setStatus("Prêt.");
         }
    }

    // --- Gestion du Chat ---
    async function sendMessage() {
        const messageText = messageInput.value.trim();
        if (!messageText) return;

        addMessage('user', messageText);
        messageInput.value = '';
        messageInput.style.height = 'auto'; // Reset height after sending

        setLoading(true);

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: messageText }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `Erreur HTTP: ${response.status}`);
            }

            const data = await response.json();
            addMessage('assistant', data.response);

        } catch (error) {
            console.error("Erreur lors de l'envoi du message:", error);
            addMessage('system', `Erreur: ${error.message}`, 'error'); // Afficher l'erreur dans le chat
            setStatus(`Erreur: ${error.message}`, true);
        } finally {
            setLoading(false);
             messageInput.focus(); // Remet le focus sur l'input
        }
    }

    // --- Gestion du Modèle ---
    async function changeModel() {
        const selectedModelSize = modelSelect.value;
         setStatus(`Changement de modèle vers ${selectedModelSize}...`);
         setLoading(true);
         try {
             const response = await fetch('/set_model', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ model_size: selectedModelSize }),
             });
             const data = await response.json();
             if (response.ok && data.success) {
                 setStatus(data.message || `Modèle changé pour ${selectedModelSize}. Nouvelle conversation démarrée.`);
                 // Réinitialiser l'interface pour la nouvelle conversation
                 chatWindow.innerHTML = ''; // Vide la fenêtre de chat
                 addMessage('assistant', "Nouvelle conversation démarrée avec le modèle sélectionné.");
                 currentConversationId = data.conversation_id; // Met à jour l'ID localement
                 await loadHistoryList(); // Rafraîchir la liste d'historique
             } else {
                 throw new Error(data.message || "Erreur lors du changement de modèle.");
             }
         } catch (error) {
             console.error("Erreur lors du changement de modèle:", error);
             addMessage('system', `Erreur changement modèle: ${error.message}`, 'error');
             setStatus(`Erreur changement modèle: ${error.message}`, true);
             // Optionnel : Revenir à la sélection précédente ?
             // modelSelect.value = previousModelValue;
         } finally {
             setLoading(false);
         }
    }

    // --- Gestion de l'Historique ---
    async function startNewChat() {
         setStatus("Démarrage d'un nouveau chat...");
         setLoading(true);
        try {
            const response = await fetch('/new_chat', { method: 'POST' });
             const data = await response.json();
             if (response.ok && data.success) {
                chatWindow.innerHTML = ''; // Vide la fenêtre
                addMessage('assistant', 'Nouvelle conversation démarrée.');
                messageInput.value = '';
                currentConversationId = data.conversation_id; // Met à jour l'ID
                setStatus('Nouveau chat prêt.');
                await loadHistoryList(); // Met à jour la liste
             } else {
                 throw new Error(data.message || "Impossible de démarrer un nouveau chat.");
             }
        } catch (error) {
            console.error("Erreur nouveau chat:", error);
            addMessage('system', `Erreur: ${error.message}`, 'error');
            setStatus(`Erreur: ${error.message}`, true);
        } finally {
            setLoading(false);
        }
    }

    async function loadHistoryList() {
        historyList.innerHTML = '<li class="loading">Chargement de l\'historique...</li>';
        try {
            const response = await fetch('/history');
            if (!response.ok) throw new Error(`Erreur HTTP: ${response.status}`);
            const data = await response.json();

            historyList.innerHTML = ''; // Vide la liste actuelle
            if (data.conversations && data.conversations.length > 0) {
                data.conversations.forEach(conv => {
                    const li = document.createElement('li');
                    li.textContent = conv.name || `Conversation ${conv.id.substring(0, 8)}`;
                    li.dataset.id = conv.id; // Stocke l'ID dans un attribut data
                    li.addEventListener('click', () => loadConversation(conv.id));
                    historyList.appendChild(li);
                });
            } else {
                historyList.innerHTML = '<li>Aucun historique trouvé.</li>';
            }
        } catch (error) {
            console.error("Erreur chargement historique:", error);
            historyList.innerHTML = '<li>Erreur chargement historique.</li>';
             setStatus(`Erreur chargement historique: ${error.message}`, true);
        }
    }

    async function loadConversation(conversationId) {
        if (conversationId === currentConversationId && chatWindow.children.length > 1) {
             setStatus("Cette conversation est déjà chargée.");
             return; // Évite de recharger inutilement
         }
         setStatus(`Chargement de la conversation ${conversationId.substring(0, 8)}...`);
         setLoading(true);
         try {
            const response = await fetch(`/history/${conversationId}`);
            if (!response.ok) {
                 const errorData = await response.json();
                throw new Error(errorData.error || `Erreur HTTP: ${response.status}`);
            }
            const data = await response.json();

            chatWindow.innerHTML = ''; // Vide la fenêtre actuelle
            if (data.history && data.history.length > 0) {
                 data.history.forEach(message => {
                    addMessage(message.role, message.content); // 'user' ou 'assistant'
                });
                currentConversationId = data.id; // Met à jour l'ID de la conv active
                setStatus(`Conversation ${conversationId.substring(0, 8)} chargée.`);
             } else {
                 addMessage('assistant', 'Cette conversation est vide ou n\'a pas pu être chargée.');
                 currentConversationId = data.id; // Met quand même à jour l'ID
                 setStatus(`Conversation ${conversationId.substring(0, 8)} chargée (vide).`);
             }
             await loadHistoryList(); // Rafraichir pour potentiellement mettre à jour le nom/date?

        } catch (error) {
            console.error(`Erreur chargement conversation ${conversationId}:`, error);
            addMessage('system', `Erreur chargement: ${error.message}`, 'error');
            setStatus(`Erreur chargement: ${error.message}`, true);
        } finally {
             setLoading(false);
         }
    }

    // --- Gestion Upload Fichiers ---
    function handleFiles(files) {
        if (files.length === 0) return;

        // Pour l'instant, on gère un seul fichier à la fois pour simplifier
        const file = files[0];
        // Validation simple côté client (optionnel, le backend valide aussi)
        const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
         if (!allowedTypes.includes(file.type) && !file.name.match(/\.(pdf|doc|docx|xls|xlsx|txt)$/i) ) {
             setStatus(`Type de fichier non supporté: ${file.name}`, true);
             addMessage('system', `Fichier non supporté : ${file.name}. Types autorisés : PDF, Word, Excel, Txt.`, 'error');
             return;
         }

        const formData = new FormData();
        formData.append('file', file);

         setStatus(`Upload de ${file.name}...`);
         setLoading(true); // Désactive l'input pendant l'upload

        fetch('/upload', {
            method: 'POST',
            body: formData,
        })
        .then(response => {
             // Vérifier si la réponse est bien du JSON avant de la parser
             const contentType = response.headers.get("content-type");
             if (contentType && contentType.indexOf("application/json") !== -1) {
                 return response.json().then(data => ({ ok: response.ok, status: response.status, data }));
             } else {
                 return response.text().then(text => { throw new Error(`Réponse inattendue du serveur: ${text}`) });
             }
         })
        .then(({ ok, status, data }) => {
            if (ok && data.success) {
                setStatus(`Fichier ${data.filename} uploadé.`);
                // Informer l'utilisateur dans le chat
                addMessage('system', `Fichier uploadé : ${data.filename}. Vous pouvez maintenant poser une question à son sujet.`);
                // NOTE : Le backend ne fait rien avec le contenu pour l'instant.
                // L'utilisateur doit explicitement demander à l'IA d'analyser le fichier.
            } else {
                throw new Error(data.error || `Erreur HTTP ${status}`);
            }
        })
        .catch(error => {
            console.error("Erreur d'upload:", error);
             addMessage('system', `Erreur d'upload : ${error.message}`, 'error');
             setStatus(`Erreur upload: ${error.message}`, true);
        })
         .finally(() => {
             setLoading(false); // Réactive l'input
             fileInput.value = null; // Réinitialise l'input fichier
         });
    }

    // --- Écouteurs d'Événements ---
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { // Envoyer avec Entrée (sauf si Shift+Entrée pour nouvelle ligne)
            e.preventDefault(); // Empêche le saut de ligne par défaut
            sendMessage();
        }
    });
     // Ajuster la hauteur du textarea automatiquement
     messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto'; // Réinitialise pour recalculer
        messageInput.style.height = (messageInput.scrollHeight) + 'px';
     });

    newChatBtn.addEventListener('click', startNewChat);
    modelSelect.addEventListener('change', changeModel);

    // Bouton pour ouvrir la sélection de fichier
    uploadBtn.addEventListener('click', () => fileInput.click());
    // Gérer le fichier sélectionné via le bouton
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    // Gestion du Drag and Drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault(); // Nécessaire pour permettre le drop
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); // Empêche le navigateur d'ouvrir le fichier
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files) {
            handleFiles(e.dataTransfer.files);
        }
    });

    // --- Initialisation ---
    loadHistoryList(); // Charge l'historique au démarrage
    // Optionnel: Charger la dernière conversation ou une conversation par défaut au démarrage?
    // startNewChat(); // Ou démarrer un nouveau chat automatiquement ?

    // Appeler changeModel une fois au début pour définir le modèle initial sélectionné dans le dropdown
    // et potentiellement démarrer la première conversation.
    // Alternativement, on pourrait juste lire la valeur et la garder côté client
    // sans appeler le backend tout de suite. Faisons un appel initial simple.
    // Décommentez si vous voulez que le modèle par défaut soit défini au backend au démarrage.
    // setTimeout(changeModel, 500); // Petit délai pour laisser le backend démarrer

    // Sélectionne le modèle par défaut dans le dropdown (basé sur la valeur `selected` dans l'HTML)
    // Et informe le backend (sans nécessairement démarrer un nouveau chat si on ne veut pas)
    async function initializeModel() {
         const initialModelSize = modelSelect.value;
         console.log(`Modèle initial sélectionné dans l'interface : ${initialModelSize}`);
         // Optionnel: Informer le backend du modèle initial sans forcément reset le chat
         /*
         try {
            await fetch('/set_model', { // Adaptez cette logique si set_model force un new chat
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_size: initialModelSize, no_reset: true }) // Flag hypothétique
            });
         } catch (error) { console.error("Erreur init modèle", error); }
         */
         // Pour l'instant, on suppose que le backend démarre avec un modèle par défaut
         // et que le premier `changeModel` ou `sendMessage` synchronisera.
    }
    initializeModel();

});
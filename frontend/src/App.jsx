import { useState, useEffect } from 'react';
import { config } from './config';

function App() {
  const [token, setToken] = useState(null);
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  
  // Edit State
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  // Auto-loaded Secure Images State
  const [secureImages, setSecureImages] = useState({});

  // Public Sharing State
  const isShareRoute = window.location.pathname.startsWith('/share/');
  const shareToken = isShareRoute ? window.location.pathname.split('/')[2] : null;
  const [publicNote, setPublicNote] = useState(null);
  const [publicError, setPublicError] = useState('');

  // 1. Auth & Share Routing
  useEffect(() => {
    if (isShareRoute && shareToken) {
      fetch(`${config.apiBaseUrl}/share/${shareToken}`)
        .then(res => {
          if (!res.ok) throw new Error("Share link invalid or expired");
          return res.json();
        })
        .then(data => setPublicNote(data))
        .catch(err => setPublicError(err.message));
      return; 
    }

    const savedToken = localStorage.getItem('access_token');
    if (savedToken) setToken(savedToken);

    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      const urlParams = new URLSearchParams(hash.substring(1));
      const accessToken = urlParams.get('access_token');
      if (accessToken) {
        setToken(accessToken);
        localStorage.setItem('access_token', accessToken);
        window.history.replaceState(null, null, ' ');
      }
    }
  }, [isShareRoute, shareToken]);

  // 2. Fetch Notes
  useEffect(() => {
    if (token && !isShareRoute) fetchNotes();
  }, [token, isShareRoute]);

  const fetchNotes = async () => {
    try {
      const response = await fetch(`${config.apiBaseUrl}/notes`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        if (response.status === 401) alert("Your session expired. Please sign in again.");
        throw new Error('Failed to fetch notes');
      }
      const data = await response.json();
      setNotes(data || []);
    } catch (error) {
      console.error("Error fetching notes:", error);
    }
  };

  // 3. Auto-Load Private Images (The Magic Trick)
  useEffect(() => {
    notes.forEach(note => {
      // If the note has attachments but we haven't loaded them yet...
      if (note.attachments && note.attachments.length > 0 && !secureImages[note.note_id]) {
        loadSecureImages(note.note_id);
      }
    });
  }, [notes]); // Re-runs whenever notes are updated

  const loadSecureImages = async (noteId) => {
    try {
      // Secretly generate a share link in the background
      const res = await fetch(`${config.apiBaseUrl}/notes/${noteId}/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      
      // Fetch the S3 Presigned URLs from that link
      const pubRes = await fetch(`${config.apiBaseUrl}/share/${data.share_token}`);
      const pubData = await pubRes.json();
      
      // Save the images to state so they render instantly
      if (pubData.attachments) {
        setSecureImages(prev => ({ ...prev, [noteId]: pubData.attachments }));
      }
    } catch (error) {
      console.error("Failed to auto-load secure images:", error);
    }
  };

  // --- CRUD OPERATIONS ---

  const handleCreateNote = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`${config.apiBaseUrl}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, content, tags: ["frontend"] })
      });
      if (response.ok) {
        setTitle('');
        setContent('');
        fetchNotes();
      }
    } catch (error) { console.error("Error creating note:", error); }
  };

  const handleDeleteNote = async (noteId) => {
    if (!window.confirm("Are you sure you want to delete this note?")) return;
    try {
      const response = await fetch(`${config.apiBaseUrl}/notes/${noteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) fetchNotes();
    } catch (error) { console.error("Error deleting note:", error); }
  };

  const startEdit = (note) => {
    setEditingId(note.note_id);
    setEditTitle(note.title);
    setEditContent(note.content);
  };

  const handleSaveEdit = async (noteId) => {
    try {
      const response = await fetch(`${config.apiBaseUrl}/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: editTitle, content: editContent })
      });
      if (response.ok) {
        setEditingId(null);
        fetchNotes();
      }
    } catch (error) { console.error("Error updating note:", error); }
  };

  const handleViewVersions = async (noteId) => {
    try {
      const response = await fetch(`${config.apiBaseUrl}/notes/${noteId}/versions`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (data.length === 0) {
        alert("No previous versions found for this note.");
      } else {
        const history = data.map((v, i) => `${i + 1}. Edited at: ${v.version_ts}`).join('\n');
        alert(`Version History:\n\n${history}`);
      }
    } catch (error) { console.error("Error fetching versions:", error); }
  };

  const handleFileUpload = async (noteId, file) => {
    if (!file) return;
    try {
      const res = await fetch(`${config.apiBaseUrl}/notes/${noteId}/attachment-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: file.name, content_type: file.type })
      });
      if (!res.ok) {
         const errData = await res.json();
         throw new Error(errData.message || "Failed to generate secure upload URL");
      }
      
      const data = await res.json();
      const uploadRes = await fetch(data.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
      });
      
      if (!uploadRes.ok) throw new Error("Direct S3 upload failed");
      
      alert("File uploaded successfully!");
      fetchNotes(); 
    } catch (error) { 
      console.error(error);
      alert(`Upload failed: ${error.message}`); 
    }
  };

  const handleShare = async (noteId) => {
    try {
      const res = await fetch(`${config.apiBaseUrl}/notes/${noteId}/share`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      const shareUrl = `${window.location.origin}/share/${data.share_token}`;
      
      await navigator.clipboard.writeText(shareUrl);
      alert(`Public link copied to your clipboard!\n\n${shareUrl}`);
    } catch (error) { console.error("Share failed:", error); }
  };

  const handleLogin = () => {
    window.location.href = `${config.cognitoDomain}/login?client_id=${config.clientId}&response_type=token&scope=email+openid+profile&redirect_uri=${config.redirectUri}`;
  };

  const handleLogout = () => {
    setToken(null);
    localStorage.removeItem('access_token');
    window.location.href = `${config.cognitoDomain}/logout?client_id=${config.clientId}&logout_uri=${config.redirectUri}`;
  };

  // --- RENDER PUBLIC SHARE VIEW ---
  if (isShareRoute) {
    return (
      <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
        <h2>CloudNotes (Shared View)</h2>
        {publicError ? <p style={{color: 'red'}}>{publicError}</p> : null}
        {publicNote ? (
          <div style={{ padding: '1.5rem', border: '2px solid #4CAF50', borderRadius: '8px', backgroundColor: '#f9f9f9', color: '#222' }}>
            <h1 style={{ margin: '0 0 10px 0', color: '#111' }}>{publicNote.title}</h1>
            <p style={{ fontSize: '16px', color: '#333' }}>{publicNote.content}</p>
            {publicNote.attachments && publicNote.attachments.length > 0 && (
              <div style={{ marginTop: '20px' }}>
                <h3 style={{ color: '#4CAF50' }}>Attachments:</h3>
                {publicNote.attachments.map((att, i) => (
                  <img key={i} src={att.url} alt="attachment" style={{ maxWidth: '100%', maxHeight: '400px', marginTop: '10px', borderRadius: '4px' }} />
                ))}
              </div>
            )}
          </div>
        ) : !publicError ? <p>Loading secure note...</p> : null}
      </div>
    );
  }

  // --- RENDER PRIVATE DASHBOARD ---
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>CloudNotes</h1>
        {token && <button onClick={handleLogout} style={{ padding: '8px 16px', backgroundColor: '#ff4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Sign Out</button>}
      </div>
      
      {!token ? (
        <div style={{ marginTop: '20px', padding: '2rem', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd', textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 10px 0', color: '#333' }}>Secure Serverless Knowledge Management</h2>
          <p style={{ color: '#666', marginBottom: '20px' }}>Please sign in to access your dashboard.</p>
          <button onClick={handleLogin} style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', backgroundColor: '#FF9900', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>Sign In via AWS Cognito</button>
        </div>
      ) : (
        <div>
          <div style={{ padding: '1rem', backgroundColor: '#333', borderRadius: '8px', marginBottom: '2rem' }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#fff' }}>Create a New Note</h3>
            <form onSubmit={handleCreateNote} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <input type="text" placeholder="Note Title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ padding: '8px', borderRadius: '4px', border: 'none' }}/>
              <textarea placeholder="Note Content" value={content} onChange={(e) => setContent(e.target.value)} rows="4" style={{ padding: '8px', borderRadius: '4px', border: 'none' }}/>
              <button type="submit" style={{ padding: '10px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Save Note</button>
            </form>
          </div>

          <h3 style={{ color: '#333' }}>Your Notes</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {notes.map(note => (
              <div key={note.note_id} style={{ padding: '1.5rem', border: '1px solid #555', borderRadius: '8px', backgroundColor: '#222' }}>
                
                {/* Editing Mode */}
                {editingId === note.note_id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '10px' }}>
                    <input value={editTitle} onChange={e => setEditTitle(e.target.value)} style={{ padding: '8px', borderRadius: '4px' }} />
                    <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows="3" style={{ padding: '8px', borderRadius: '4px' }} />
                    <div>
                      <button onClick={() => handleSaveEdit(note.note_id)} style={{ padding: '6px 15px', marginRight: '10px', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Save Changes</button>
                      <button onClick={() => setEditingId(null)} style={{ padding: '6px 15px', backgroundColor: '#888', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  /* View Mode */
                  <>
                    <h2 style={{ margin: '0 0 10px 0', color: '#fff' }}>{note.title}</h2>
                    <p style={{ margin: '0 0 15px 0', fontSize: '16px', color: '#ddd' }}>{note.content}</p>
                    <div style={{ marginBottom: '15px' }}>
                      <button onClick={() => startEdit(note)} style={{ padding: '6px 12px', marginRight: '8px', backgroundColor: '#f39c12', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Edit Note</button>
                      <button onClick={() => handleDeleteNote(note.note_id)} style={{ padding: '6px 12px', marginRight: '8px', backgroundColor: '#e74c3c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Delete</button>
                      <button onClick={() => handleViewVersions(note.note_id)} style={{ padding: '6px 12px', backgroundColor: '#9b59b6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>View History</button>
                    </div>

                    {/* Auto-loaded images */}
                    {secureImages[note.note_id] && (
                      <div style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#111', borderRadius: '4px' }}>
                        <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: '#888' }}>Attached Images:</p>
                        {secureImages[note.note_id].map((att, i) => (
                          <img key={i} src={att.url} alt="attachment" style={{ maxWidth: '100%', maxHeight: '300px', marginTop: '5px', borderRadius: '4px', display: 'block' }} />
                        ))}
                      </div>
                    )}
                  </>
                )}
                
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', borderTop: '1px solid #444', paddingTop: '15px', marginTop: '10px' }}>
                  <input type="file" accept="image/*" onChange={(e) => handleFileUpload(note.note_id, e.target.files[0])} style={{ fontSize: '12px', color: '#ccc' }} />
                  <button onClick={() => handleShare(note.note_id)} style={{ padding: '8px 16px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                    Generate Public Link
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
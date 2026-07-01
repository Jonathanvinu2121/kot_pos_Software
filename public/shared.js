// Shared script for POS system authentication and sockets

function getAuthToken() {
  return localStorage.getItem('pos_token');
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem('pos_token', token);
  } else {
    localStorage.removeItem('pos_token');
  }
}

function getCurrentUser() {
  const token = getAuthToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload;
  } catch (e) {
    console.error('Failed to parse JWT payload', e);
    return null;
  }
}

function logout() {
  setAuthToken(null);
  window.location.reload();
}

// Global API Fetch helper
async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // Session expired or invalid
    setAuthToken(null);
    window.location.reload();
    throw new Error('Unauthorized');
  }
  return res;
}

// Setup common header
function setupHeader(containerId, titleText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  const user = getCurrentUser();
  if (!user) return;
  
  container.innerHTML = `
    <header class="app-header">
      <div class="app-brand">${titleText}</div>
      <div class="user-badge">
        <span class="user-role-label">${user.role}</span>
        <span style="font-size: 14px; opacity: 0.8;">User #${user.user_id}</span>
        <button class="logout-btn" onclick="logout()">Logout</button>
      </div>
    </header>
  `;
}

// Show a beautiful warning toast (soft-conflict)
function showToast(title, body) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast-header">${title}</div>
    <div class="toast-body">${body}</div>
  `;
  
  container.appendChild(toast);
  
  // Auto-remove after 6 seconds
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease-out forwards';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// Render dynamic overlay modal for hard-conflict resolution
let activeModalResolve = null; // resolve promise
function showConflictModal(title, message, conflictDetails) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('conflict-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'conflict-modal-overlay';
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-title" id="modal-title-text">Conflict Detected</div>
          <div class="modal-body" id="modal-body-text"></div>
          <div class="conflict-detail-box" id="modal-details-box"></div>
          <div class="modal-actions" style="margin-top: 24px;">
            <button class="btn btn-success" id="modal-btn-accept" style="flex: 1;">Accept (Overwrites State)</button>
            <button class="btn btn-danger" id="modal-btn-reject" style="flex: 1;">Reject (Keep Existing)</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    
    document.getElementById('modal-title-text').innerText = title;
    document.getElementById('modal-body-text').innerText = message;
    
    const detailsBox = document.getElementById('modal-details-box');
    if (conflictDetails) {
      detailsBox.style.display = 'block';
      detailsBox.innerText = JSON.stringify(conflictDetails, null, 2);
    } else {
      detailsBox.style.display = 'none';
    }
    
    overlay.classList.add('active');
    
    const acceptBtn = document.getElementById('modal-btn-accept');
    const rejectBtn = document.getElementById('modal-btn-reject');
    
    // Clean up previous event listeners
    const newAcceptBtn = acceptBtn.cloneNode(true);
    const newRejectBtn = rejectBtn.cloneNode(true);
    acceptBtn.parentNode.replaceChild(newAcceptBtn, acceptBtn);
    rejectBtn.parentNode.replaceChild(newRejectBtn, rejectBtn);
    
    newAcceptBtn.addEventListener('click', () => {
      overlay.classList.remove('active');
      resolve('accept');
    });
    
    newRejectBtn.addEventListener('click', () => {
      overlay.classList.remove('active');
      resolve('reject');
    });
  });
}

// Generate a random client HLC
function generateHLC(deviceId) {
  return `${Date.now()}-0-${deviceId}`;
}

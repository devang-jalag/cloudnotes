// src/config.js

export const config = {
    // API Gateway URL
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    
    // Cognito Auth Details
    cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN,
    clientId: import.meta.env.VITE_CLIENT_ID,
    
    // Local dev URL (We will change this to CloudFront later)
    //redirectUri: "http://localhost:5173/" 
    redirectUri: import.meta.env.VITE_REDIRECT_URI 
};
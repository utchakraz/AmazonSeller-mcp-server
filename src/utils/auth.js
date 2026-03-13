import axios from 'axios';
import crypto from 'crypto-js';

// Cache for access tokens
let accessTokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Get an access token for SP-API
 */
export async function getAccessToken() {
  // Check if we have a valid cached token
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now) {
    return accessTokenCache.token;
  }

  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Cache the token
    accessTokenCache = {
      token: response.data.access_token,
      expiresAt: now + (response.data.expires_in * 1000) - 60000 // Subtract 1 minute for safety
    };

    return accessTokenCache.token;
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Amazon SP-API');
  }
}

/**
 * Generate AWS signature for SP-API requests
 */
export function generateAWSSignature(accessToken, method, path, payload = '', queryParams = {}) {
  // The SP-API Host prefix (e.g., fe, na, eu)
  const endpointPrefix = process.env.SP_API_REGION || 'us-east-1';
  // The AWS Signature Region (e.g., us-west-2 for fe, us-east-1 for na, eu-west-1 for eu)
  let awsRegion = 'us-east-1';
  if (endpointPrefix === 'fe') awsRegion = 'us-west-2';
  if (endpointPrefix === 'eu') awsRegion = 'eu-west-1';

  const service = 'execute-api';
  const host = `sellingpartnerapi-${endpointPrefix}.amazon.com`;
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = datetime.substring(0, 8);

  // Create canonical request
  const canonicalUri = path;

  // Sort and encode query parameters
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map(key => {
      return `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`;
    })
    .join('&');

  // Create canonical headers
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-date:${datetime}\n`;

  const signedHeaders = 'host;x-amz-date';

  // Create payload hash
  const payloadHash = crypto.SHA256(payload).toString();

  // Combine elements to create canonical request
  const canonicalRequest =
    `${method}\n` +
    `${canonicalUri}\n` +
    `${canonicalQueryString}\n` +
    `${canonicalHeaders}\n` +
    `${signedHeaders}\n` +
    `${payloadHash}`;

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign =
    `${algorithm}\n` +
    `${datetime}\n` +
    `${credentialScope}\n` +
    `${crypto.SHA256(canonicalRequest).toString()}`;

  // Calculate signature using the correct AWS Region for signing
  const kDate = crypto.HmacSHA256(date, `AWS4${process.env.SP_API_AWS_SECRET_KEY}`);
  const kRegion = crypto.HmacSHA256(awsRegion, kDate);
  const kService = crypto.HmacSHA256(service, kRegion);
  const kSigning = crypto.HmacSHA256('aws4_request', kService);
  const signature = crypto.HmacSHA256(stringToSign, kSigning).toString();

  // Create authorization header
  const authorizationHeader =
    `${algorithm} ` +
    `Credential=${process.env.SP_API_AWS_ACCESS_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    'x-amz-date': datetime,
    'Authorization': authorizationHeader
  };
}

/**
 * Make a request to the SP-API
 */
export async function makeSpApiRequest(method, path, data = null, queryParams = {}) {
  try {
    const accessToken = await getAccessToken();
    const endpointPrefix = process.env.SP_API_REGION || 'us-east-1';

    // Sort and encode query parameters for the URL
    let queryString = Object.keys(queryParams)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
      .join('&');

    if (queryString) {
      queryString = `?${queryString}`;
    }

    const url = `https://sellingpartnerapi-${endpointPrefix}.amazon.com${path}${queryString}`;

    const payload = data ? JSON.stringify(data) : '';
    const awsHeaders = generateAWSSignature(accessToken, method, path, payload, queryParams);

    const response = await axios({
      method,
      url,
      data: data ? data : undefined,
      headers: {
        'host': `sellingpartnerapi-${endpointPrefix}.amazon.com`,
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
        ...awsHeaders
      }
    });

    return response.data;
  } catch (error) {
    console.error('SP-API request failed:', error.response?.data || error.message);
    throw new Error(`SP-API request failed: ${error.response?.data?.errors?.[0]?.message || error.message}`);
  }
}

const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

/**
 * Dynamically load Remita configuration based on the environment toggle
 */
function getRemitaConfig() {
    const isSandbox = process.env.REMITA_ENVIRONMENT === "SANDBOX";
    return {
        merchantId: isSandbox ? process.env.REMITA_SB_MERCHANT_ID : process.env.REMITA_LIVE_MERCHANT_ID,
        publicKey: isSandbox ? process.env.REMITA_SB_PUBLIC_KEY : process.env.REMITA_LIVE_PUBLIC_KEY,
        secretKey: isSandbox ? process.env.REMITA_SB_SECRET_KEY : process.env.REMITA_LIVE_SECRET_KEY,
        baseUrl: isSandbox ? process.env.REMITA_SB_BASE_URL : process.env.REMITA_LIVE_BASE_URL,
        isSandbox: isSandbox
    };
}

/**
 * Validate RRR format (12 digits)
 */
function isValidRRR(rrr) {
    const normalized = (rrr || '').replace(/[\s-]/g, '');
    const rrrPattern = /^\d{12}$/;
    return rrrPattern.test(normalized);
}

/**
 * Verify Remita Payment via API
 */
async function verifyRemitaPayment(rrr) {
    try {
        const normalizedRRR = (rrr || '').replace(/[\s-]/g, '');

        if (!isValidRRR(normalizedRRR)) {
            return {
                success: false,
                error: 'Invalid RRR format',
                message: 'RRR must be exactly 12 digits'
            };
        }

        const config = getRemitaConfig();
        
        // Generate SHA-512 cryptographic signature: rrr + secretKey + merchantId
        const hashString = normalizedRRR + config.secretKey + config.merchantId;
        const signature = crypto.createHash('sha512').update(hashString).digest('hex');
        
        // Construct API endpoint
        const url = `${config.baseUrl}/query/${normalizedRRR}`;
        
        console.log(`\n[Remita ${config.isSandbox ? 'Sandbox' : 'Live'}] Verifying RRR:`, normalizedRRR);
        console.log(`[Remita] API URL:`, url);
        
        // Make API request via GET with dynamic headers
        const response = await axios.get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': config.publicKey,
                'REQUEST-SIGNATURE': signature,
                'MERCHANT-ID': config.merchantId
            },
            timeout: 15000
        });
        
        console.log('[Remita] Response:', response.data);
        
        return {
            success: true,
            data: response.data,
            message: 'Payment verified successfully'
        };
        
    } catch (error) {
        console.error('❌ Remita API Error:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data || error.message,
            message: error.response?.data?.message || 'Verification failed. Ensure keys are correct.'
        };
    }
}

/**
 * Generate a Sandbox RRR for Defense Testing
 */
async function generateSandboxRRR() {
    const config = getRemitaConfig();
    
    if (!config.isSandbox) {
        throw new Error('Cannot generate test RRR in LIVE environment');
    }

    try {
        const orderId = `DEFENSE_${Date.now()}`;
        const amount = "45000";
        // To do a real API call, we need a serviceTypeId. 
        const serviceTypeId = process.env.REMITA_SB_SERVICE_TYPE_ID || "4430731"; // 4430731 is a common demo ID
        
        // Invoice generation signature: merchantId + serviceTypeId + orderId + amount + secretKey
        const hashString = config.merchantId + serviceTypeId + orderId + amount + config.secretKey;
        const hash = crypto.createHash('sha512').update(hashString).digest('hex');
        
        const url = `${config.baseUrl}/echannelsvc/merchant/api/paymentinit`;
        
        console.log(`\n[Remita Sandbox] Generating test RRR...`);
        const response = await axios.post(url, {
            serviceTypeId: serviceTypeId,
            amount: amount,
            orderId: orderId,
            payerName: "NELFUND Defense Tester",
            payerEmail: "test@futb.edu.ng",
            payerPhone: "08000000000",
            description: "Refund Portal Defense Test"
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `remitaConsumerKey=${config.merchantId},remitaConsumerToken=${hash}`
            }
        });

        // Remita sometimes wraps the JSON in a jsonp string e.g., jsonp ({"statuscode":"025","RRR":"..."})
        let rawData = response.data;
        if (typeof rawData === 'string' && rawData.startsWith('jsonp')) {
            rawData = JSON.parse(rawData.substring(rawData.indexOf('{'), rawData.lastIndexOf('}') + 1));
        }

        console.log('[Remita Sandbox] Generated Data:', rawData);

        if (rawData.statuscode === '025' || rawData.RRR) {
            return {
                success: true,
                rrr: rawData.RRR,
                amount: amount,
                message: 'Sandbox RRR generated successfully'
            };
        } else {
            throw new Error(rawData.status || 'Failed to generate RRR');
        }

    } catch (error) {
        console.error('❌ Sandbox RRR Generation Error:', error.message);
        return {
            success: false,
            error: error.message,
            message: 'Failed to generate sandbox RRR. Ensure your keys are correct.'
        };
    }
}

/**
 * Check if payment status is successful
 */
function isPaymentSuccessful(verificationResult) {
    if (!verificationResult.success) return false;
    
    const status = verificationResult.data?.status;
    const message = verificationResult.data?.message?.toLowerCase();
    
    return (
        status === '00' || 
        status === '01' || 
        status === 'success' ||
        message?.includes('success') ||
        message?.includes('approved')
    );
}

/**
 * Extract payment details from verification result
 */
function extractPaymentDetails(verificationResult) {
    if (!verificationResult.success) return null;
    
    const data = verificationResult.data;
    
    return {
        rrr: data.RRR || data.rrr,
        amount: parseFloat(data.amount || 0),
        transactionDate: data.transactiontime || data.paymentDate || new Date().toISOString(),
        payerName: data.payerName || 'N/A',
        payerEmail: data.payerEmail || 'N/A',
        payerPhone: data.payerPhoneNumber || 'N/A',
        status: data.status,
        statusMessage: data.message || data.statusMessage || 'Verified'
    };
}

module.exports = {
    verifyRemitaPayment,
    generateSandboxRRR,
    isPaymentSuccessful,
    extractPaymentDetails,
    isValidRRR,
    getRemitaConfig
};
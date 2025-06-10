import axios, { AxiosResponse } from 'axios';
import { z } from 'zod';

// Environment validation for Crossmint
const crossmintEnvSchema = z.object({
  CROSSMINT_API_KEY: z.string().min(1, 'Crossmint API key is required'),
  CROSSMINT_PROJECT_ID: z.string().min(1, 'Crossmint project ID is required'),
});

// Validate environment variables on import
const crossmintEnv = crossmintEnvSchema.parse({
  CROSSMINT_API_KEY: process.env.CROSSMINT_API_KEY,
  CROSSMINT_PROJECT_ID: process.env.CROSSMINT_PROJECT_ID,
});

// Crossmint Headless Checkout API Types (CORRECTED)
const PhysicalAddressSchema = z.object({
  name: z.string(),
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string().optional(), // Required for US addresses
  postalCode: z.string(),
  country: z.string(),
});

const RecipientSchema = z.object({
  email: z.string(),
  physicalAddress: PhysicalAddressSchema.optional(),
});

const PaymentSchema = z.object({
  method: z.enum(['ethereum-sepolia', 'polygon-amoy', 'base-sepolia', 'arbitrum-sepolia']),
  currency: z.enum(['usdc', 'eth']),
  payerAddress: z.string(),
  receiptEmail: z.string().optional(),
});

// Updated LineItems schema to be an object
const LineItemsSchema = z.object({
  productLocator: z.string().describe("The product locator. Ex: 'amazon:<amazon_product_id>', 'amazon:<asin>'"),
});

const CreateOrderRequestSchema = z.object({
  recipient: RecipientSchema,
  payment: PaymentSchema,
  lineItems: LineItemsSchema, // Single object, not array
});

const OrderResponseSchema = z.object({
  order: z.object({
    orderId: z.string(),
    phase: z.string(),
    locale: z.string().optional(),
    lineItems: z.array(z.object({
      chain: z.string(),
      quantity: z.number(),
      metadata: z.object({
        name: z.string(),
        description: z.string(),
        imageUrl: z.string().optional(),
      }).optional(),
      quote: z.object({
        status: z.string(),
        charges: z.object({
          unit: z.object({
            amount: z.string(),
            currency: z.string(),
          }),
          salesTax: z.object({
            amount: z.string(),
            currency: z.string(),
          }).optional(),
          shipping: z.object({
            amount: z.string(),
            currency: z.string(),
          }).optional(),
        }),
        totalPrice: z.object({
          amount: z.string(),
          currency: z.string(),
        }),
      }),
      delivery: z.object({
        status: z.string(),
        recipient: z.object({
          locator: z.string(),
          email: z.string(),
          walletAddress: z.string().optional(),
        }),
      }),
    })),
    quote: z.object({
      status: z.string(),
      quotedAt: z.string().optional(),
      expiresAt: z.string().optional(),
      totalPrice: z.object({
        amount: z.string(),
        currency: z.string(),
      }),
    }),
    payment: z.object({
      status: z.string(),
      method: z.string(),
      currency: z.string(),
      preparation: z.object({
        chain: z.string().optional(),
        payerAddress: z.string().optional(),
        serializedTransaction: z.string().optional(),
      }).optional(),
    }),
  }),
  orderClientSecret: z.string().optional(),
});

// Export types
export type PhysicalAddress = z.infer<typeof PhysicalAddressSchema>;
export type Recipient = z.infer<typeof RecipientSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type LineItem = z.infer<typeof LineItemsSchema>;
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// Amazon product info interface
export interface AmazonProduct {
  title: string;
  price: string;
  amazonUrl: string;
  imageUrl?: string;
  description?: string;
}

class CrossmintHeadlessCheckoutService {
  private readonly baseURL = 'https://staging.crossmint.com/api/2022-06-09';
  private readonly apiKey = crossmintEnv.CROSSMINT_API_KEY;

  /**
   * Extract Amazon product locator from URL
   */
  extractProductLocator(amazonUrl: string): string | null {
    try {
      console.log(`🔍 === PRODUCT LOCATOR EXTRACTION DEBUG ===`);
      console.log(`📎 Original URL: ${amazonUrl}`);
      
      // Method 1: Extract ASIN and use amazon:ASIN format
      const asinMatch = amazonUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      
      if (asinMatch && asinMatch[1] !== undefined) {
        const extractedAsin = asinMatch[1] as string;
        console.log(`✅ ASIN extracted: ${extractedAsin}`);
        
        // Try multiple locator formats
        const locatorFormats = [
          `amazon:${extractedAsin}`,
          `amazon:https://www.amazon.com/dp/${extractedAsin}`,
          extractedAsin
        ];
        
        console.log(`🔄 Available locator formats:`);
        locatorFormats.forEach((format, index) => {
          console.log(`   ${index + 1}. ${format}`);
        });
        
        // For now, use the first format (standard)
        const selectedLocator = locatorFormats[0] as string;
        console.log(`📍 Selected locator: ${selectedLocator}`);
        console.log(`================================================\n`);
        
        return selectedLocator;
      }
      
      // Method 2: Try to extract from different URL patterns
      const urlMatch = amazonUrl.match(/amazon\.com\/dp\/([A-Z0-9]{10})/i);
      
      if (urlMatch && urlMatch[1] !== undefined) {
        const asinFromUrl = urlMatch[1] as string;
        console.log(`✅ ASIN extracted (method 2): ${asinFromUrl}`);
        const locator = `amazon:${asinFromUrl}`;
        console.log(`📍 Selected locator: ${locator}`);
        console.log(`================================================\n`);
        return locator;
      }
      
      console.warn(`❌ Could not extract ASIN from URL: ${amazonUrl}`);
      console.log(`================================================\n`);
      return null;
    } catch (error) {
      console.error('❌ Error extracting product locator:', error);
      console.log(`================================================\n`);
      return null;
    }
  }

  /**
   * Determine the best blockchain for user's wallet
   */
  getBestBlockchainForWallet(_walletAddress: string): string {
    // For now, default to base-sepolia for testnet
    // In production, you might want to check the wallet's preferred chain
    // or use the chain with the most USDC balance
    // TODO: Use _walletAddress to determine optimal blockchain
    return 'base-sepolia';
  }

  /**
   * Try multiple product locator formats for a given ASIN
   */
  private getProductLocatorVariations(asin: string, amazonUrl: string): string[] {
    return [
      `amazon:${asin}`,                                    // Standard format
      `amazon:https://www.amazon.com/dp/${asin}`,         // Full URL format  
      `amazon:${amazonUrl}`,                               // Original URL format
      asin,                                                // Just ASIN
      `https://www.amazon.com/dp/${asin}`                  // Clean URL format
    ];
  }

  /**
   * Create order with retry mechanism for different product locator formats
   */
  private async createOrderWithRetry(
    orderRequest: CreateOrderRequest,
    productLocatorVariations: string[]
  ): Promise<OrderResponse> {
    let lastError: any = null;
    
    for (let i = 0; i < productLocatorVariations.length; i++) {
      const locator = productLocatorVariations[i];
      console.log(`\n🔄 === ATTEMPT ${i + 1}/${productLocatorVariations.length} ===`);
      console.log(`📍 Trying locator: ${locator}`);
      
      // Update the order request with current locator
      const currentRequest = {
        ...orderRequest,
        lineItems: {
          productLocator: locator
        }
      };

      try {
        console.log('📦 REQUEST PAYLOAD:');
        console.log(JSON.stringify(currentRequest, null, 2));
        console.log('=================================\n');

        const response: AxiosResponse = await axios.post(
          `${this.baseURL}/orders`,
          currentRequest,
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.apiKey,
            },
            timeout: 30000,
          }
        );

        console.log(`\n✅ === SUCCESS WITH FORMAT ${i + 1} ===`);
        console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
        console.log('📦 FULL RESPONSE BODY:');
        console.log(JSON.stringify(response.data, null, 2));
        console.log('=================================\n');

        // Parse and return successful response
        return OrderResponseSchema.parse(response.data);
        
      } catch (error) {
        console.log(`❌ Format ${i + 1} failed: ${locator}`);
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = error.response?.data?.message;
          console.log(`   Status: ${status}, Message: ${message}`);
          lastError = error;
          
          // If it's not a "Product not found" error, stop trying
          if (status !== 400 || !message?.includes('Product not found')) {
            throw error;
          }
        } else {
          console.log(`   Error: ${error}`);
          lastError = error;
        }
        console.log('=================================\n');
      }
    }
    
    // If all formats failed, throw the last error
    console.log(`❌ ALL PRODUCT LOCATOR FORMATS FAILED`);
    throw lastError;
  }

  /**
   * Create a headless checkout order for Amazon product using crypto wallet
   */
  async createWalletAmazonOrder(
    product: AmazonProduct,
    userEmail: string,
    walletAddress: string,
    shippingAddress: PhysicalAddress
  ): Promise<OrderResponse & { requiresTransaction: boolean; serializedTransaction?: string }> {
    try {
      console.log(`🛒 Creating crypto wallet order for: ${product.title}`);
      console.log(`👛 Using wallet: ${walletAddress.substring(0, 8)}...${walletAddress.substring(-6)}`);
      
      const productLocator = this.extractProductLocator(product.amazonUrl);
      if (!productLocator) {
        throw new Error('Could not extract product locator from Amazon URL');
      }

      // Extract ASIN for creating variations
      const asinMatch = product.amazonUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (!asinMatch || !asinMatch[1]) {
        throw new Error('Could not extract ASIN from Amazon URL');
      }
      const asin = asinMatch[1];

      // Validate physical address for US only
      if (shippingAddress.country !== 'US') {
        throw new Error('Only US shipping addresses are supported at this time');
      }

      if (!shippingAddress.state) {
        throw new Error('State is required for US shipping addresses');
      }

      const blockchainMethod = this.getBestBlockchainForWallet(walletAddress);

      const orderRequest: CreateOrderRequest = {
        recipient: {
          email: userEmail,
          physicalAddress: shippingAddress,
        },
        payment: {
          method: blockchainMethod as any, // Cast to satisfy enum
          currency: 'usdc',
          payerAddress: walletAddress, // REQUIRED: User's wallet address
          receiptEmail: userEmail,
        },
        lineItems: {
          productLocator, // Amazon product locator as object, not array
        },
      };

      console.log(`🔗 Product locator: ${productLocator}`);
      console.log(`💰 Payment method: ${blockchainMethod} with USDC`);
      console.log(`👛 Payer address: ${walletAddress}`);
      console.log(`📧 Recipient: ${userEmail}`);
      console.log(`📦 Shipping to: ${shippingAddress.city}, ${shippingAddress.state}, ${shippingAddress.country}`);

      console.log('\n🚀 === CROSSMINT API REQUEST DEBUG ===');
      console.log(`📡 URL: POST ${this.baseURL}/orders`);
      console.log(`🔑 API Key: ${this.apiKey.substring(0, 12)}...${this.apiKey.substring(-8)}`);

      const productLocatorVariations = this.getProductLocatorVariations(asin, product.amazonUrl);
      const validatedResponse = await this.createOrderWithRetry(orderRequest, productLocatorVariations);
      console.log(`✅ Parsed Order ID: ${validatedResponse.order.orderId}`);
      
      // Check for error conditions
      const order = validatedResponse.order;
      
      // Check for insufficient funds
      if (order.payment.status === "crypto-payer-insufficient-funds") {
        throw new Error("Insufficient USDC funds in wallet");
      }

      // Check for physical address requirement
      if (order.quote.status === "requires-physical-address") {
        throw new Error("Physical address is required for this product");
      }

      // Get serialized transaction for user to sign
      const serializedTransaction = order.payment.preparation?.serializedTransaction;
      
      if (!serializedTransaction) {
        throw new Error(
          `No serialized transaction found for order. This item may not be available for purchase.`
        );
      }

      return {
        ...validatedResponse,
        requiresTransaction: true,
        serializedTransaction,
      };

    } catch (error) {
      console.error('❌ Crossmint headless order creation error:', error);
      
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.response?.statusText;
        const errorData = error.response?.data;
        
        console.error('❌ Crossmint API error details:', {
          status,
          message,
          data: errorData
        });
        
        if (status === 400) {
          throw new Error(`Invalid order data: ${message || 'Check product locator and payment details'}`);
        }
        if (status === 401 || status === 403) {
          throw new Error('Invalid Crossmint API key or insufficient permissions');
        }
        if (status === 404) {
          throw new Error('Product not found or not supported for Amazon purchases');
        }
        if (status && status >= 500) {
          throw new Error('Crossmint service is temporarily unavailable');
        }
        
        throw new Error(`Order creation failed: ${message || error.message}`);
      }
      
      if (error instanceof z.ZodError) {
        console.error('Response validation error:', error.errors);
        throw new Error('Invalid response format from Crossmint API');
      }
      
      throw new Error(`Unexpected error during order creation: ${error}`);
    }
  }

  /**
   * Get order status by ID
   */
  async getOrder(orderId: string): Promise<any> {
    try {
      console.log(`\n🔍 === CROSSMINT GET ORDER DEBUG ===`);
      console.log(`📡 URL: GET ${this.baseURL}/orders/${orderId}`);
      console.log(`🔑 API Key: ${this.apiKey.substring(0, 12)}...${this.apiKey.substring(-8)}`);
      console.log('=======================================\n');

      const response = await axios.get(
        `${this.baseURL}/orders/${orderId}`,
        {
          headers: {
            'x-api-key': this.apiKey,
          },
          timeout: 15000,
        }
      );

      console.log(`\n✅ === ORDER STATUS RESPONSE DEBUG ===`);
      console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
      console.log('📦 FULL ORDER STATUS RESPONSE:');
      console.log(JSON.stringify(response.data, null, 2));
      console.log('=====================================\n');

      return response.data;
    } catch (error) {
      console.error('❌ Error fetching order:', error);
      if (axios.isAxiosError(error)) {
        console.error('❌ Order fetch error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data
        });
      }
      throw error;
    }
  }

  /**
   * Sign and submit transaction to complete the order payment
   * Following the exact Crossmint Checkout guide flow
   */
  async signOrderTransaction(
    walletAddress: string, 
    serializedTransaction: string, 
    chain: string = 'base-sepolia'
  ): Promise<{ 
    success: boolean; 
    transactionId?: string; 
    status?: string; 
    transactionData?: any; 
    error?: string 
  }> {
    try {
      console.log('\n🔐 === CROSSMINT TRANSACTION SIGNING DEBUG ===');
      // Use the exact API endpoint from the guide: /api/2022-06-09/wallets
      const walletApiUrl = `${this.baseURL}/wallets/${walletAddress}/transactions`;
      console.log(`📡 URL: POST ${walletApiUrl}`);
      console.log(`🔑 API Key: ${this.apiKey.substring(0, 12)}...${this.apiKey.substring(-8)}`);
      console.log(`👛 Wallet: ${walletAddress}`);
      console.log(`⛓️ Chain: ${chain}`);
      console.log(`📝 Serialized Transaction: ${serializedTransaction.substring(0, 30)}...`);

      // Use the exact payload format from the guide
      const transactionPayload = {
        params: {
          calls: [{
            transaction: serializedTransaction
          }],
          chain: chain
        }
      };

      console.log('📦 TRANSACTION PAYLOAD:');
      console.log(JSON.stringify(transactionPayload, null, 2));
      console.log('===========================================\n');

      const response = await axios.post(
        walletApiUrl,
        transactionPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          timeout: 30000,
        }
      );

      console.log(`\n✅ === TRANSACTION SIGNING RESPONSE DEBUG ===`);
      console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
      console.log('📦 FULL TRANSACTION RESPONSE:');
      console.log(JSON.stringify(response.data, null, 2));
      console.log('===========================================\n');

      if (response.status === 200 || response.status === 201) {
        const transactionData = response.data;
        const transactionId = transactionData.id || transactionData.transactionId;
        const transactionStatus = transactionData.status;
        
        console.log(`✅ Transaction submitted successfully: ${transactionId}`);
        console.log(`📊 Transaction status: ${transactionStatus}`);
        
        // Return the transaction status and data for approval handling
        return {
          success: true,
          transactionId: transactionId,
          status: transactionStatus,
          transactionData: transactionData
        };
      } else {
        console.error(`❌ Transaction signing failed with status: ${response.status}`);
        return {
          success: false,
          error: `Transaction failed with status: ${response.status}`
        };
      }

    } catch (error: any) {
      console.error('❌ Error signing transaction:', error);
      
      if (error.response) {
        console.error('❌ Transaction signing error details:', {
          status: error.response.status,
          message: error.response.statusText,
          data: error.response.data
        });
        
        return {
          success: false,
          error: `Transaction signing failed: ${error.response.data?.message || error.response.statusText}`
        };
      } else {
        return {
          success: false,
          error: `Network error: ${error.message}`
        };
      }
    }
  }

  /**
   * Check if a product is supported for Amazon checkout
   */
  async checkAmazonProductSupport(productLocator: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `${this.baseURL}/orders/tokens/support`,
        {
          params: { 
            productLocator: productLocator
          },
          headers: {
            'x-api-key': this.apiKey,
          },
          timeout: 10000,
        }
      );

      return response.data.supported === true;
    } catch (error) {
      console.error('Error checking Amazon product support:', error);
      return false;
    }
  }

  /**
   * Health check for Crossmint headless service
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple API key validation check
      const response = await axios.get(
        `${this.baseURL}/orders/tokens/support?productLocator=amazon:B01DFKC2SO`,
        {
          headers: {
            'x-api-key': this.apiKey,
          },
          timeout: 10000,
        }
      );
      
      return response.status === 200;
    } catch (error) {
      console.error('Crossmint headless service health check failed:', error);
      return false;
    }
  }

  /**
   * Validate Amazon URL and extract product info
   */
  validateAmazonUrl(url: string): boolean {
    try {
      const amazonUrlPattern = /amazon\.com\/.*\/dp\/[A-Z0-9]{10}/i;
      return amazonUrlPattern.test(url);
    } catch (error) {
      console.error('Error validating Amazon URL:', error);
      return false;
    }
  }

  /**
   * Get transaction details including pending approval data
   */
  async getTransactionDetails(
    walletAddress: string,
    transactionId: string
  ): Promise<{ 
    transaction: any; 
    pendingMessage?: string; 
    signerLocator?: string; 
    error?: string 
  }> {
    try {
      console.log('\n🔍 === GETTING TRANSACTION DETAILS FOR APPROVAL ===');
      const walletApiUrl = `${this.baseURL}/wallets/${walletAddress}/transactions/${transactionId}`;
      console.log(`📡 URL: GET ${walletApiUrl}`);
      console.log(`🔑 API Key: ${this.apiKey.substring(0, 12)}...${this.apiKey.substring(-8)}`);
      console.log(`👛 Wallet: ${walletAddress}`);
      console.log(`📝 Transaction ID: ${transactionId}`);

      const response = await axios.get(
        walletApiUrl,
        {
          headers: {
            'x-api-key': this.apiKey,
          },
          timeout: 15000,
        }
      );

      console.log(`\n✅ === TRANSACTION DETAILS RESPONSE ===`);
      console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
      console.log('📦 FULL TRANSACTION RESPONSE:');
      console.log(JSON.stringify(response.data, null, 2));
      console.log('========================================\n');

      const transactionData = response.data;
      
      // Extract pending approval information
      if (transactionData.status === 'awaiting-approval' && 
          transactionData.approvals && 
          transactionData.approvals.pending && 
          transactionData.approvals.pending.length > 0) {
        
        const pendingApproval = transactionData.approvals.pending[0]; // Get first pending approval
        const pendingMessage = pendingApproval.message;
        const signerLocator = pendingApproval.signer;
        
        console.log(`✅ Found pending approval:`);
        console.log(`   📝 Message to sign: ${pendingMessage}`);
        console.log(`   🔐 Signer: ${signerLocator}`);
        
        return {
          transaction: transactionData,
          pendingMessage: pendingMessage,
          signerLocator: signerLocator
        };
      } else {
        console.log(`⚠️ No pending approvals found. Status: ${transactionData.status}`);
        return {
          transaction: transactionData,
          error: `Transaction is not awaiting approval. Current status: ${transactionData.status}`
        };
      }

    } catch (error: any) {
      console.error('❌ Error fetching transaction details:', error);
      
      if (error.response) {
        console.error('❌ Transaction fetch error details:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        return {
          transaction: null,
          error: `Failed to fetch transaction: ${error.response.data?.message || error.response.statusText}`
        };
      } else {
        return {
          transaction: null,
          error: `Network error: ${error.message}`
        };
      }
    }
  }

  /**
   * Submit approval signature for a pending transaction
   * Uses the official Crossmint Wallet API for passkey approval
   */
  async approveTransaction(
    walletAddress: string,
    transactionId: string,
    signerLocator: string,
    signature: {
      r: string;
      s: string;
    },
    metadata: {
      authenticatorData: string;
      challengeIndex: number;
      clientDataJSON: string;
      typeIndex: number;
      userVerificationRequired: boolean;
    }
  ): Promise<{ 
    success: boolean; 
    transaction?: any; 
    error?: string 
  }> {
    try {
      console.log('\n🔐 === SUBMITTING TRANSACTION APPROVAL ===');
      const approvalApiUrl = `${this.baseURL}/wallets/${walletAddress}/transactions/${transactionId}/approvals`;
      console.log(`📡 URL: POST ${approvalApiUrl}`);
      console.log(`🔑 API Key: ${this.apiKey.substring(0, 12)}...${this.apiKey.substring(-8)}`);
      console.log(`👛 Wallet: ${walletAddress}`);
      console.log(`📝 Transaction ID: ${transactionId}`);
      console.log(`🔐 Signer: ${signerLocator}`);

      // Construct the approval payload according to Crossmint API docs
      const approvalPayload = {
        approvals: [{
          signer: signerLocator,
          signature: {
            r: signature.r,
            s: signature.s
          },
          metadata: {
            authenticatorData: metadata.authenticatorData,
            challengeIndex: metadata.challengeIndex,
            clientDataJSON: metadata.clientDataJSON,
            typeIndex: metadata.typeIndex,
            userVerificationRequired: metadata.userVerificationRequired
          }
        }]
      };

      console.log('📦 APPROVAL PAYLOAD:');
      console.log(JSON.stringify(approvalPayload, null, 2));
      console.log('===========================================\n');

      const response = await axios.post(
        approvalApiUrl,
        approvalPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          timeout: 30000,
        }
      );

      console.log(`\n✅ === APPROVAL SUBMISSION RESPONSE ===`);
      console.log(`📊 Response Status: ${response.status} ${response.statusText}`);
      console.log('📦 FULL APPROVAL RESPONSE:');
      console.log(JSON.stringify(response.data, null, 2));
      console.log('=====================================\n');

      if (response.status === 201) {
        console.log(`✅ Transaction approval submitted successfully`);
        return {
          success: true,
          transaction: response.data
        };
      } else {
        console.error(`❌ Approval submission failed with status: ${response.status}`);
        return {
          success: false,
          error: `Approval failed with status: ${response.status}`
        };
      }

    } catch (error: any) {
      console.error('❌ Error submitting approval:', error);
      
      if (error.response) {
        console.error('❌ Approval submission error details:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
        
        return {
          success: false,
          error: `Approval submission failed: ${error.response.data?.message || error.response.statusText}`
        };
      } else {
        return {
          success: false,
          error: `Network error: ${error.message}`
        };
      }
    }
  }

}

// Export singleton instance
export const crossmintHeadlessCheckoutService = new CrossmintHeadlessCheckoutService(); 
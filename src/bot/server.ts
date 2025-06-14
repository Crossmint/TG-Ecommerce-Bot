import express, { Request, Response, NextFunction } from 'express';
import { config } from '../utils/config.js';
import * as memoryUtils from '../utils/memory.js';
import { telegramBot } from './platforms/telegram.js';
import { crossmintWalletService } from '../commerce/crossmint/wallet.js';

/**
 * HTTP Server for handling webhooks from web interface
 */
export class BotHttpServer {
  private app: express.Application;
  private server: any;
  private isRunning = false;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Add CORS for web interface communication
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // Webhook endpoint for wallet creation completion
    this.app.post('/api/webhook/wallet-created', async (req: Request, res: Response): Promise<void> => {
      try {
        const { userId, walletAddress, crossmintUserId, email, authToken } = req.body;

        if (!userId || !walletAddress || !crossmintUserId) {
          res.status(400).json({
            error: 'Missing required fields: userId, walletAddress, crossmintUserId'
          });
          return;
        }
        
        // Verify the userId is a number (critical for proper storage)
        const numericUserId = Number(userId);
        if (isNaN(numericUserId)) {
          console.error(`❌ Invalid userId format: ${userId}. Must be a number.`);
          res.status(400).json({
            error: 'Invalid userId format. Must be a number.'
          });
          return;
        }

        console.log(`💰 Wallet created for user ${userId}: ${walletAddress}`);

        // Update wallet service with the new wallet information
        const walletData = { 
          crossmintUserId, 
          walletAddress, 
          authToken,
          email 
        };
        
        // This is the critical part - update the Crossmint wallet service
        crossmintWalletService.updateUserAuth(numericUserId, walletData);
        
        // Double check that the wallet is now properly registered
        console.log(`🔍 Wallet creation verification: User ${numericUserId} now has wallet = ${crossmintWalletService.hasWallet(numericUserId)}`);
        
        // Also update user memory with wallet information for redundancy
        const memory = memoryUtils.getUserMemory(numericUserId);
        if (memory) {
          // Add wallet info to memory (extend the interface if needed)
          (memory as any).walletInfo = {
            address: walletAddress,
            crossmintUserId,
            email,
            authToken,
            createdAt: Date.now(),
            isVerified: true
          };
        }
        
        // Debug logging - check if wallet is now detected
        console.log(`🔍 Wallet detection after creation: hasWallet=${crossmintWalletService.hasWallet(numericUserId)}`);
        console.log(`📋 Wallet user data: ${JSON.stringify(crossmintWalletService.getUser(numericUserId))}`);
        

        // Notify user on Telegram
        await telegramBot.sendMessage(
          numericUserId,
          `🎉 Wallet Created Successfully!\n\n` +
          `✅ Your Crossmint wallet has been created and linked to your account.\n` +
          `💰 Wallet Address: ${walletAddress.substring(0, 8)}...${walletAddress.substring(-6)}\n\n` +
          `You can now:\n` +
          `• Check your balance with /balance\n` +
          `• Add funds with /topup\n` +
          `• Start shopping with /search`
        );

        res.json({
          success: true,
          message: 'Wallet creation processed successfully',
          userId: numericUserId,
          walletAddress: walletAddress.substring(0, 8) + '...' + walletAddress.substring(-6)
        });

      } catch (error) {
        console.error('❌ Error processing wallet creation:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process wallet creation'
        });
      }
    });

    // Logout endpoint for web interface notifications
    this.app.post('/api/logout', async (req: Request, res: Response): Promise<void> => {
      try {
        const { userId, source = 'web', timestamp } = req.body;

        if (!userId || typeof userId !== 'number') {
          res.status(400).json({
            error: 'Missing or invalid userId'
          });
          return;
        }

        console.log(`🚪 Logout notification from ${source} for user ${userId} at ${timestamp || Date.now()}`);

        // Clear user data from wallet service
        const logoutSuccess = crossmintWalletService.clearUser(userId);
        
        // Also clear user memory for complete cleanup
        if (logoutSuccess) {
          memoryUtils.clearUserMemory(userId);
          console.log(`✅ User ${userId} logged out from ${source} - session data cleared`);
        }

        res.json({
          success: true,
          message: 'Logout processed successfully',
          userId,
          sessionCleared: logoutSuccess
        });

      } catch (error) {
        console.error('❌ Error processing logout notification:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process logout'
        });
      }
    });

    // Webhook endpoint for payment completion
    this.app.post('/api/webhook/payment-completed', async (req: Request, res: Response): Promise<void> => {
      try {
        const { sessionId, amount, currency, transactionId, userId } = req.body;

        if (!sessionId || !amount || !transactionId) {
          res.status(400).json({
            error: 'Missing required fields: sessionId, amount, transactionId'
          });
          return;
        }

        console.log(`💳 Payment completed: $${amount} for user ${userId || 'unknown'}`);

        // If we have userId, verify their updated balance and notify them
        if (userId) {
          const memory = memoryUtils.getUserMemory(userId);
          if (memory && (memory as any).walletInfo) {
            // ✅ REAL BALANCE VERIFICATION: Fetch actual balance from Crossmint API
            try {
              console.log(`💰 Verifying real balance for user ${userId} after payment of $${amount}`);
              const realBalanceData = await crossmintWalletService.getWalletBalance(userId);
              
              if (realBalanceData) {
                const usdcBalance = realBalanceData.balances.find(b => b.currency === 'USDC')?.amount || '0.00';
                console.log(`✅ Real USDC balance verified: ${usdcBalance} USDC`);
                
                // Update memory with real balance data for caching
            (memory as any).walletInfo.lastTopUpAmount = amount;
            (memory as any).walletInfo.lastTopUpAt = Date.now();
                (memory as any).walletInfo.lastVerifiedBalance = usdcBalance;
                (memory as any).walletInfo.lastBalanceCheck = Date.now();

                // Notify user with real balance confirmation
            await telegramBot.sendMessage(
              userId,
              `💰 *Payment Successful!*\n\n` +
              `✅ $${amount} ${currency} has been added to your wallet.\n` +
                  `💰 *Current Balance:* ${parseFloat(usdcBalance).toFixed(2)} USDC\n` +
              `🔄 Transaction ID: \`${transactionId}\`\n\n` +
              `Your wallet is now funded and ready for shopping!\n` +
              `Use /search to find products or /balance to check your current balance.`,
              { parse_mode: 'Markdown' }
            );
              } else {
                // Fallback if balance fetch fails
                console.log(`⚠️ Could not verify balance for user ${userId}, using fallback notification`);
                (memory as any).walletInfo.lastTopUpAmount = amount;
                (memory as any).walletInfo.lastTopUpAt = Date.now();
                
                await telegramBot.sendMessage(
                  userId,
                  `💰 *Payment Successful!*\n\n` +
                  `✅ $${amount} ${currency} has been processed.\n` +
                  `🔄 Transaction ID: \`${transactionId}\`\n\n` +
                  `Use /balance to check your updated balance.`,
                  { parse_mode: 'Markdown' }
                );
              }
            } catch (balanceError) {
              console.error('❌ Error verifying real balance after payment:', balanceError);
              
              // Fallback notification without balance verification
              (memory as any).walletInfo.lastTopUpAmount = amount;
              (memory as any).walletInfo.lastTopUpAt = Date.now();
              
              await telegramBot.sendMessage(
                userId,
                `💰 *Payment Successful!*\n\n` +
                `✅ $${amount} ${currency} has been processed.\n` +
                `🔄 Transaction ID: \`${transactionId}\`\n\n` +
                `Use /balance to check your updated balance.`,
                { parse_mode: 'Markdown' }
              );
            }
          }
        }

        res.json({
          success: true,
          message: 'Payment processed successfully',
          sessionId,
          amount,
          transactionId
        });

      } catch (error) {
        console.error('❌ Error processing payment:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process payment'
        });
      }
    });

    // Webhook endpoint for transaction approval completion
    this.app.post('/api/webhook/transaction-approved', async (req: Request, res: Response): Promise<void> => {
      try {
        const { userId, transactionId, orderId, status, walletAddress: _walletAddress } = req.body;

        if (!userId || !transactionId || !orderId || !status) {
          res.status(400).json({
            error: 'Missing required fields: userId, transactionId, orderId, status'
          });
          return;
        }

        console.log(`🔐 Transaction approval: ${transactionId} for user ${userId} - Status: ${status}`);

        if (status === 'approved') {
          try {
            // ✅ REAL BALANCE VERIFICATION: Verify balance after successful transaction
            console.log(`💰 Verifying real balance for user ${userId} after transaction approval`);
            const realBalanceData = await crossmintWalletService.getWalletBalance(userId);
            
            let balanceMessage = '';
            if (realBalanceData) {
              const usdcBalance = realBalanceData.balances.find(b => b.currency === 'USDC')?.amount || '0.00';
              console.log(`✅ Real USDC balance verified: ${usdcBalance} USDC after transaction`);
              balanceMessage = `💰 *Current Balance:* ${parseFloat(usdcBalance).toFixed(2)} USDC\\.\n`;
              
              // Update user memory with real balance
              const memory = memoryUtils.getUserMemory(userId);
              if (memory && (memory as any).walletInfo) {
                (memory as any).walletInfo.lastVerifiedBalance = usdcBalance;
                (memory as any).walletInfo.lastBalanceCheck = Date.now();
              }
            }
            
            // Notify user on Telegram that their transaction was approved
            await telegramBot.sendMessage(
              userId,
              `✅ *Payment Approved Successfully\\!*\n\n` +
              `🔐 Your transaction has been approved with your passkey\\.\n` +
              `💰 Payment is now being processed\\.\n` +
              balanceMessage +
              `📦 Your order will be shipped to your address\\.\n\n` +
              `*Order ID:* \`${orderId}\`\n` +
              `*Transaction ID:* \`${transactionId}\`\n\n` +
              `You will receive email updates about your order status\\.`,
              { 
                parse_mode: 'MarkdownV2',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🔄 Check Order Status',
                        callback_data: `check_order:${orderId}`
                      }
                    ],
                    [
                      {
                        text: '🔍 Search More Products',
                        callback_data: 'search_more'
                      }
                    ]
                  ]
                }
              }
            );
            
            console.log(`✅ User ${userId} notified of transaction approval with verified balance`);
            
          } catch (error) {
            console.error('❌ Error verifying balance after transaction approval:', error);
            
            // Fallback notification without balance verification
            await telegramBot.sendMessage(
              userId,
              `✅ *Payment Approved Successfully\\!*\n\n` +
              `🔐 Your transaction has been approved with your passkey\\.\n` +
              `💰 Payment is now being processed\\.\n` +
              `📦 Your order will be shipped to your address\\.\n\n` +
              `*Order ID:* \`${orderId}\`\n` +
              `*Transaction ID:* \`${transactionId}\`\n\n` +
              `Use /balance to check your updated balance\\.\n` +
              `You will receive email updates about your order status\\.`,
              { 
                parse_mode: 'MarkdownV2',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🔄 Check Order Status',
                        callback_data: `check_order:${orderId}`
                      }
                    ],
                    [
                      {
                        text: '🔍 Search More Products',
                        callback_data: 'search_more'
                      }
                    ]
                  ]
                }
              }
            );
            
            console.log(`✅ User ${userId} notified of transaction approval (fallback)`);
          }
        } else {
          // Handle approval failure
          await telegramBot.sendMessage(
            userId,
            `❌ *Transaction Approval Failed*\n\n` +
            `Your transaction could not be approved\\. Please try again or contact support\\.`,
            { parse_mode: 'MarkdownV2' }
          );
          
          console.log(`❌ User ${userId} notified of transaction approval failure`);
        }

        res.json({
          success: true,
          message: 'Transaction approval processed successfully',
          userId,
          transactionId,
          orderId,
          status
        });

      } catch (error) {
        console.error('❌ Error processing transaction approval:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process transaction approval'
        });
      }
    });

    // Webhook endpoint for delegation completion
    this.app.post('/api/webhook/delegation-completed', async (req: Request, res: Response): Promise<void> => {
      try {
        const { userId, botSigner, status } = req.body;

        if (!userId || !botSigner || !status) {
          res.status(400).json({
            error: 'Missing required fields: userId, botSigner, status'
          });
          return;
        }
        
        const numericUserId = Number(userId);
        if (isNaN(numericUserId)) {
          console.error(`❌ Invalid userId format: ${userId}. Must be a number.`);
          res.status(400).json({
            error: 'Invalid userId format. Must be a number.'
          });
          return;
        }

        console.log(`🤖 Delegation completed for user ${userId}: ${status}`);

        if (status === 'success') {
          // Notify user on Telegram that delegation was successful
          await telegramBot.sendMessage(
            numericUserId,
            `✅ *Fast Shopping Enabled\\!*\n\n` +
            `🤖 The bot can now automatically sign transactions for instant purchases\\.\n\n` +
            `*Benefits:*\n` +
            `• No more manual approvals\n` +
            `• Instant checkout experience\n` +
            `• Seamless shopping\n\n` +
            `You can revoke this permission anytime\\. Try searching for products with \\/search to see the difference\\!`,
            { 
              parse_mode: 'MarkdownV2',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🔍 Try Fast Shopping',
                      callback_data: 'search_more'
                    }
                  ]
                ]
              }
            }
          );
          
          console.log(`✅ User ${userId} notified of successful delegation`);
        } else {
          // Handle delegation failure
          await telegramBot.sendMessage(
            numericUserId,
            `❌ *Delegation Failed*\n\n` +
            `Unable to enable fast shopping\\. Please try again or contact support\\.`,
            { parse_mode: 'MarkdownV2' }
          );
          
          console.log(`❌ User ${userId} notified of delegation failure`);
        }

        res.json({
          success: true,
          message: 'Delegation completion processed successfully',
          userId: numericUserId,
          status
        });

      } catch (error) {
        console.error('❌ Error processing delegation completion:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to process delegation completion'
        });
      }
    });

    // Webhook endpoint for retrieving user wallet status (for web interface)
    this.app.get('/api/user/:userId/wallet', async (req: Request, res: Response): Promise<void> => {
      try {
        const userId = parseInt(req.params.userId || '0', 10);
        
        if (!userId) {
          res.status(400).json({ error: 'Invalid userId format.' });
          return;
        }

        const hasWallet = crossmintWalletService.hasWallet(userId);
        const userWallet = crossmintWalletService.getUser(userId);

        if (!hasWallet || !userWallet || !userWallet.walletAddress) {
          console.log(`[API] Wallet not found for user ${userId}`);
          res.status(404).json({
            error: 'Wallet not found',
            hasWallet: false,
          });
          return;
        }

        console.log(`[API] Wallet found for user ${userId}: ${userWallet.walletAddress}`);
        res.json({
          success: true,
          hasWallet: true,
          wallet: {
            address: userWallet.walletAddress,
            crossmintUserId: userWallet.crossmintUserId,
            email: userWallet.email,
            isVerified: true, // If it exists, it's verified.
            createdAt: userWallet.createdAt,
          },
        });

      } catch (error) {
        console.error('❌ Error fetching wallet status:', error);
        res.status(500).json({
          error: 'Internal server error'
        });
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
      });
    });
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log('🌐 HTTP server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(config.app.port, () => {
        console.log(`🌐 Bot HTTP server running on port ${config.app.port}`);
        console.log(`📍 Webhook endpoints available at:`);
        console.log(`   • POST /api/webhook/wallet-created`);
        console.log(`   • POST /api/logout`);
        console.log(`   • POST /api/webhook/payment-completed`);
        console.log(`   • POST /api/webhook/transaction-approved`);
        console.log(`   • POST /api/webhook/delegation-completed`);
        console.log(`   • GET  /api/user/:userId/wallet`);
        console.log(`   • GET  /health`);
        this.isRunning = true;
        resolve();
      });

      this.server.on('error', (error: any) => {
        console.error('❌ HTTP server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      console.log('🌐 HTTP server not running');
      return;
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('✅ HTTP server stopped');
        this.isRunning = false;
        resolve();
      });
    });
  }

  /**
   * Get server status
   */
  public getStatus(): boolean {
    return this.isRunning;
  }

  /**
   * Get server port
   */
  public getPort(): number {
    return config.app.port;
  }
}

/**
 * Export singleton instance
 */
export const botHttpServer = new BotHttpServer(); 
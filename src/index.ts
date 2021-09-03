import { Connection, Account, clusterApiUrl, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeAccount } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { liquidate, getAccountsAtRisk, createAccountsOnAllCollaterals } from './utils'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 10 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 1000
const NETWORK = Network.DEV

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    NETWORK,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  const prices = await new Prices(connection, assetsList)
  await prices.initializationPromise

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(wallet, connection, assetsList)

  const xUSDAddress = assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  const xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(XUSD_BEFORE_WARNING))
    console.warn(`Account is low on xUSD (${xUSDAccount.amount.toString()})`)

  // Main loop
  let nextFullCheck = 0
  let nextCheck = 0
  let atRisk: Synchronizer<ExchangeAccount>[] = []

  while (true) {
    if (Date.now() > nextFullCheck + CHECK_ALL_INTERVAL) {
      nextFullCheck = Date.now() + CHECK_ALL_INTERVAL
      // Fetching all accounts with debt over limit
      const newAccounts = await getAccountsAtRisk(connection, exchange, exchangeProgram)

      atRisk = newAccounts.map((fresh) => {
        return new Synchronizer<ExchangeAccount>(
          connection,
          fresh.address,
          'ExchangeAccount',
          fresh.data
        )
      })
    }

    if (Date.now() > nextCheck + CHECK_AT_RISK_INTERVAL) {
      nextCheck = Date.now() + CHECK_AT_RISK_INTERVAL
      const slot = new BN(await connection.getSlot())

      console.log(`Checking accounts suitable for liquidation (${atRisk.length})..`)
      console.time('checking time')

      for (const exchangeAccount of atRisk) {
        // Users are sorted so we can stop checking if deadline is in the future
        if (slot.lt(exchangeAccount.account.liquidationDeadline)) break

        await liquidate(
          connection,
          exchange,
          exchangeAccount,
          assetsList,
          state,
          collateralAccounts,
          wallet,
          xUSDAccount.amount,
          xUSDAccount.address
        )
      }

      console.log('Finished checking')
      console.timeEnd('checking time')
    }

    const closerCheck = nextCheck < nextFullCheck ? nextCheck : nextFullCheck
    await sleep(closerCheck - Date.now() + 1)
  }
}

main()

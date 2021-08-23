const { BASE_FEE, Keypair, Networks, Operation, Server, TransactionBuilder } = require("stellar-sdk");
const assert = require('assert');

const supportedNetworks = {
    TESTNET: {
        network: 'TESTNET',
        getServer: () => new Server('https://horizon-testnet.stellar.org'),
        transactionOptions: { fee: BASE_FEE, networkPassphrase: Networks.TESTNET, },
    },
    LIVENET: {
        network: 'LIVENET',
        getServer: () => new Server('https://horizon.stellar.org'),
        transactionOptions: { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC, },
    },
};
/**
 * `AccountHelper` provides basic actions around an account.
 *
 * Use the following methods to interact with an account object:
 * * `{@link AccountHelper.getFunded}`
 *
 * @constructor
 * @param {string} id The id for the account to interact with. Can either be the private or the public key
 * @param {string} [network] The network to interact with (*TESTNET* or LIVENET)
 */
class AccountHelper {
    constructor(id, network) {
        network = network || supportedNetworks.TESTNET.network;
        assert(
            Object.keys(supportedNetworks).includes(network),
            `Network must be one of [${Object.keys(supportedNetworks)}]`
        );
        this.selectedNetwork = supportedNetworks[network];
        try {
            this.accountKeypair = Keypair.fromSecret(id);
        } catch (_) {}
        try {
            this.accountKeypair = Keypair.fromPublicKey(id);
            console.log('Attention! You only provided a public key. Make sure you have access to the secret if you want to access funds sent to this account.');
        } catch (_) {}
        assert(this.accountKeypair, '`id` must be a valid account ID or secret.');
    };

    /**
     * Retrieves the account this `AccountHelper` object is referencing to.
     * If the account does not exist, yet it will try to create it on the fly.
     *
     * @param {object} createAccountOptions Options for the case
     *                                      the account needs to be created.
     * @param {number} [createAccountOptions.funds] Amount to fund the account with (defaults to 5000)
     * @param {Keypair} [createAccountOptions.sponsorKeypair] Keypair of account to create new account from
     *                  The Keypair must contain a secret key.
     */
    async getFunded (createAccountOptions = {}) {
        const keypair = this.accountKeypair;
        const server = this.selectedNetwork.getServer();
        const fundBalance = `${(createAccountOptions.funds || 5000)}`;
        return await server.loadAccount(keypair.publicKey())
            .then(account => {
                console.log('Account already exists - not funding.');
                return account;
            })
            .catch(() => {
                const fundingKeypair = createAccountOptions.sponsorKeypair || Keypair.random();
                assert(fundingKeypair.canSign(), 'sponsorKeypair must contain a secret in order to sign.');
                return server.loadAccount(fundingKeypair.publicKey())
                    .then(fundingAccount => {
                        console.log(`Account does not exist - funding with ${fundBalance} XLM.`);
                        const transaction = new TransactionBuilder(fundingAccount, this.selectedNetwork.transactionOptions)
                            .addOperation(Operation.createAccount({
                                destination: keypair.publicKey(),
                                startingBalance: fundBalance,
                            }))
                            .setTimeout(0)
                            .build();
                        transaction.sign(fundingKeypair);
                        return server.submitTransaction(transaction)
                            .then(() => server.loadAccount(keypair.publicKey()))
                            .catch(err => {
                                console.log(err.response.data.extras.result_codes);
                                return err;
                            });
                    })
                    .catch(err => {
                        console.log('Funding account does not exist - asking a friend(ly) bot.');
                        return server.friendbot(fundingKeypair.publicKey()).call()
                            .then(() => this.getFunded({
                                funds: fundBalance,
                                sponsorKeypair: fundingKeypair,
                            }));
                    });
            });
    };

    async reset() {
        throw new Error('Not implemented');
    };
};

module.exports = { SupportedNetworks: supportedNetworks, AccountHelper: AccountHelper };

//> tests
const test_getFunded_Works_with_default_funds = async function() {
    const BigNumber = require('bignumber.js');

    const newAccount = await new AccountHelper(Keypair.random().secret(), supportedNetworks.TESTNET.network)
        .getFunded();

    assert(
        new BigNumber(newAccount.balances[0].balance).eq(5000),
        'New account is expected to hold 5000 XLM.'
    );
    return true;
};

const test_GetFunded_Returns_preexisting_account = async function() {
    const keypair = Keypair.random();
    const newAccount = await new AccountHelper(keypair.secret())
        .getFunded({funds: 1});
    const existingAccount = await new AccountHelper(keypair.secret())
        .getFunded({funds: 10});

    assert(newAccount.id === existingAccount.id, 'Expected same account IDs');
    assert(newAccount.balances[0].balance === existingAccount.balances[0].balance, 'Account should not hold more than 1 XLM.');

    return true;
};

const test_getFunded_Works_without_existing_funding_account = async function() {
    const BigNumber = require('bignumber.js');

    const newAccount = await new AccountHelper(Keypair.random().secret(), 'TESTNET')
        .getFunded({funds: 1});

    assert(
        new BigNumber(newAccount.balances[0].balance).eq(1),
        'New account is expected to hold 1 XLM.'
    );
    return true;
};

const test_getFunded_Works_with_existing_funding_account = async function() {
    const BigNumber = require('bignumber.js');
    const fundingKeypair = Keypair.random();
    await supportedNetworks['TESTNET'].getServer().friendbot(fundingKeypair.publicKey()).call();

    const newAccount = await new AccountHelper(Keypair.random().secret())
        .getFunded({funds: 1000, sponsorKeypair: fundingKeypair});

    assert(
        new BigNumber(newAccount.balances[0].balance).eq(1000),
        'New account is expected to hold 1000 XLM.'
    );
    return supportedNetworks['TESTNET'].getServer().loadAccount(fundingKeypair.publicKey())
        .catch(() => false)
        .then(fundingAccount => {
            const balance = fundingAccount.balances[0].balance;
            assert(
                new BigNumber(balance).eq(8999.99999),
                `Funding account is expected to have 8999.99999 XLM after funding and fees, but had ${balance}.`
            );
            return true;
        });
};

const allTests = () => test_getFunded_Works_with_default_funds()
    .then(() => test_GetFunded_Returns_preexisting_account())
    .then(() => test_getFunded_Works_without_existing_funding_account())
    .then(() => test_getFunded_Works_with_existing_funding_account());

module.exports.test = allTests;

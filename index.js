const { BASE_FEE, Keypair, Memo, Networks, Operation, Server, TransactionBuilder } = require("stellar-sdk");
const BigNumber = require('bignumber.js');
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
     * @param {number} [createAccountOptions.funds] Amount to fund the account with (defaults to 0 - creating a sponsored account)
     * @param {Keypair} [createAccountOptions.sponsorKeypair] Keypair of account to create new account from
     *                  The Keypair must contain a secret key. If this is the same as the account to be created no intermediate
     *                  sponsor account will be created - works only on testnet where friendbot can be asked.
     * @param {boolean} [createAccountOptions.anonymousSponsor] Indicates if the sponsor secret is known or not
     */
    async getFunded (createAccountOptions = {}) {
        const keypair = this.accountKeypair;
        const server = this.selectedNetwork.getServer();
        const fundBalance = `${(createAccountOptions.funds || 0)}`;
        return await server.loadAccount(keypair.publicKey())
            .then(account => {
                console.log('Account already exists - not funding.');
                return account;
            })
            .catch(() => {
                const fundingKeypair = createAccountOptions.sponsorKeypair || Keypair.random();
                assert(fundingKeypair.canSign(), 'sponsorKeypair must contain a secret in order to sign.');
                if (new BigNumber(fundBalance).isZero()) {
                    assert(keypair.canSign(), 'In order to create a sponsored account the secret must be provided');
                }
                return server.loadAccount(fundingKeypair.publicKey())
                    .then(fundingAccount => {
                        console.log(`Account does not exist - funding with ${fundBalance} XLM.`);
                        const transactionBuilder = new TransactionBuilder(fundingAccount, this.selectedNetwork.transactionOptions);
                        if (keypair.canSign()) {
                            transactionBuilder.addOperation(Operation.beginSponsoringFutureReserves({
                                sponsoredId: keypair.publicKey(),
                            }));
                        }
                        transactionBuilder.addOperation(Operation.createAccount({
                            destination: keypair.publicKey(),
                            startingBalance: fundBalance,
                        }))
                        if (createAccountOptions.anonymousSponsor) {
                            transactionBuilder.addOperation(Operation.setOptions({
                                signer: {
                                    ed25519PublicKey: keypair.publicKey(),
                                    weight: 1,
                                },
                            }));
                        }
                        if (keypair.canSign()) {
                            transactionBuilder.addOperation(Operation.endSponsoringFutureReserves({
                                source: keypair.publicKey(),
                            }));
                        }
                        const transaction = transactionBuilder
                            .addMemo(Memo.text('stellar-account-helper'))
                            .setTimeout(0)
                            .build();

                        transaction.sign(fundingKeypair);
                        if (keypair.canSign()) {
                            transaction.sign(keypair);
                        }

                        return server.submitTransaction(transaction)
                            .then(() => server.loadAccount(keypair.publicKey()))
                            .catch(err => {
                                console.log(err.response.data.extras.result_codes);
                                return err;
                            });
                    })
                    .catch(err => {
                        const isDirect = fundingKeypair.publicKey() === keypair.publicKey();
                        console.log((isDirect?'Requested':'Funding')+' account does not exist - asking a friend(ly) bot.');
                        return server.friendbot(fundingKeypair.publicKey()).call()
                            .then(() => isDirect
                                ? server.loadAccount(fundingKeypair.publicKey())
                                : this.getFunded({
                                    funds: fundBalance,
                                    sponsorKeypair: fundingKeypair,
                                    anonymousSponsor: true,
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
        new BigNumber(newAccount.balances[0].balance).eq(0),
        'New account is expected to hold 0 XLM.'
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

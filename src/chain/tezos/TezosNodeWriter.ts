import { KeyStore, StoreType } from '../../types/wallet/KeyStore';
import * as TezosTypes from '../../types/tezos/TezosChainTypes';
import { TezosConstants } from '../../types/tezos/TezosConstants';
import * as TezosP2PMessageTypes from '../../types/tezos/TezosP2PMessageTypes';
import * as TezosRPCTypes from '../../types/tezos/TezosRPCResponseTypes';
import { TezosNodeReader } from './TezosNodeReader';
import { TezosMessageCodec } from './TezosMessageCodec';
import { TezosMessageUtils } from './TezosMessageUtil';
import { TezosLanguageUtil } from './TezosLanguageUtil';
import { CryptoUtils } from '../../utils/CryptoUtils';

import FetchSelector from '../../utils/FetchSelector'
const fetch = FetchSelector.getFetch();

import DeviceSelector from '../../utils/DeviceSelector';
let LedgerUtils = DeviceSelector.getLedgerUtils();

import LogSelector from '../../utils/LoggerSelector';
const log = LogSelector.getLogger();

/**
 *  Functions for sending operations on the Tezos network.
 */
export namespace TezosNodeWriter {
    /**
     * Send a POST request to a Tezos node.
     * 
     * @param {string} server Which Tezos node to go against
     * @param {string} command RPC route to invoke
     * @param {object} payload Payload to submit
     * @returns {Promise<object>} JSON-encoded response
     */
    function performPostRequest(server: string, command: string, payload = {}): Promise<Response> {
        const url = `${server}/${command}`;
        const payloadStr = JSON.stringify(payload);

        log.debug(`TezosNodeWriter.performPostRequest sending ${payloadStr}\n->\n${url}`);

        return fetch(url, { method: 'post', body: payloadStr, headers: { 'content-type': 'application/json' } });
    }

    /**
     * Signs a forged operation
     * @param {string} forgedOperation Forged operation group returned by the Tezos client (as a hex string)
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {SignedOperationGroup} Bytes of the signed operation along with the actual signature
     */
    // TODO: move this function to wallet files
    export async function signOperationGroup(forgedOperation: string, keyStore: KeyStore, derivationPath: string): Promise<TezosTypes.SignedOperationGroup> {
        const watermarkedForgedOperationBytesHex = TezosConstants.OperationGroupWatermark + forgedOperation;

        let opSignature: Buffer;
        switch (keyStore.storeType) {
            case StoreType.Hardware:
                opSignature = await LedgerUtils.signTezosOperation(derivationPath, watermarkedForgedOperationBytesHex);
                break;
            default:
                const hashedWatermarkedOpBytes = CryptoUtils.simpleHash(Buffer.from(watermarkedForgedOperationBytesHex, 'hex'), 32);
                const privateKeyBytes = TezosMessageUtils.writeKeyWithHint(keyStore.privateKey, 'edsk');

                opSignature = await CryptoUtils.signDetached(hashedWatermarkedOpBytes, privateKeyBytes);
        }

        const hexSignature: string = TezosMessageUtils.readSignatureWithHint(opSignature, 'edsig').toString();
        const signedOpBytes = Buffer.concat([Buffer.from(forgedOperation, 'hex'), Buffer.from(opSignature)]);

        return { bytes: signedOpBytes, signature: hexSignature.toString() };
    }

    /**
     * Forge an operation group.
     *
     * @param {string} branch Hash of the current top block.
     * @param {object[]} operations The operations being forged as part of this operation group.
     *
     * @returns {string} Forged operation bytes (as a hex string)
     */
    // TODO: move to an appropriate place
    export function forgeOperations(branch: string, operations: TezosP2PMessageTypes.Operation[]): string {
        log.debug('TezosNodeWriter.forgeOperations:');
        log.debug(operations);
        let encoded = TezosMessageUtils.writeBranch(branch);
        operations.forEach(m => encoded += TezosMessageCodec.encodeOperation(m));

        return encoded;
    }

    /**
     * Forge an operation group using the Tezos RPC client. This is not a trustless path, but 'reveal', 'transaction', 'delegation', 'origination' operations are validated with a local parse. This method is available because the internal Michelson/Micheline converter is not yet 100% complete.
     * @deprecated
     *
     * @param {string} server Tezos node to connect to
     * @param {TezosRPCTypes.TezosBlock} blockHead The block head
     * @param {object[]} operations The operations being forged as part of this operation group
     *
     * @returns {Promise<string>} Forged operation bytes (as a hex string)
     */
    export async function forgeOperationsRemotely(server: string, blockHead: TezosRPCTypes.TezosBlock, operations: TezosP2PMessageTypes.Operation[]): Promise<string> {
        log.debug('TezosNodeWriter.forgeOperations:');
        log.debug(operations);
        log.warn('forgeOperationsRemotely() is not intrinsically trustless');
        const response = await performPostRequest(server, 'chains/main/blocks/head/helpers/forge/operations', { branch: blockHead.hash, contents: operations });
        const forgedOperation = await response.text();
        const ops = forgedOperation.replace(/\n/g, '').replace(/['"]+/g, '');

        let optypes = Array.from(operations.map(o => o["kind"]));
        let validate = false;
        for (let t in optypes) {
            validate = ['reveal', 'transaction', 'delegation', 'origination'].includes(t);
            if (validate) { break; }
        }

        if (validate) {
            const decoded = TezosMessageCodec.parseOperationGroup(ops);

            for (let i = 0; i < operations.length; i++) {
                const clientop = operations[i];
                const serverop = decoded[i];
                if (clientop['kind'] === 'transaction') { // Smart contract invocation parameters are not parsed due to limitations in the Michelson converter
                    if (serverop.kind !== clientop['kind'] || serverop.fee !== clientop['fee'] || serverop.amount !== clientop['amount'] || serverop.destination !== clientop['destination']) {
                        throw new Error('Forged transaction failed validation.');
                    }
                } else if (clientop['kind'] === 'delegation') {
                    if (serverop.kind !== clientop['kind'] || serverop.fee !== clientop['fee'] || serverop.delegate !== clientop['delegate']) {
                        throw new Error('Forged delegation failed validation.');
                    }
                } else if (clientop['kind'] === 'origination') {
                    if (serverop.kind !== clientop['kind'] || serverop.fee !== clientop['fee'] || serverop.balance !== clientop['balance'] || serverop.spendable !== clientop['spendable'] || serverop.delegatable !== clientop['delegatable'] || serverop.delegate !== clientop['delegate'] || serverop.script !== undefined) {
                        throw new Error('Forged origination failed validation.');
                    }
                }
            }
        }

        return ops;
    }

    /**
     * Applies an operation using the Tezos RPC client.
     *
     * @param {string} server Tezos node to connect to
     * @param {string} branch Hash of the current top block
     * @param {string} protocol Protocol of the current top block
     * @param {Operation[]} operations The operations to create and send
     * @param {SignedOperationGroup} signedOpGroup Signed operation group
     * @returns {Promise<AppliedOperation>} Array of contract handles
     */
    export async function applyOperation(server: string, branch: string, protocol: string, operations: TezosP2PMessageTypes.Operation[], signedOpGroup: TezosTypes.SignedOperationGroup): Promise<TezosTypes.AlphaOperationsWithMetadata[]> {
        const payload = [{
            protocol: protocol,
            branch: branch,
            contents: operations,
            signature: signedOpGroup.signature
        }];

        const response = await performPostRequest(server, 'chains/main/blocks/head/helpers/preapply/operations', payload);
        const text = await response.text();
        try {
            log.debug(`TezosNodeWriter.applyOperation received ${text}`);

            const json = JSON.parse(text);
            return json as TezosTypes.AlphaOperationsWithMetadata[];
        } catch (err) {
            log.error(`TezosNodeWriter.applyOperation failed to parse response`);
            throw new Error(`Could not parse JSON response from chains/main/blocks/head/helpers/preapply/operation: '${text}' for ${payload}`);
        }
    }

    /**
     * Ensures the results of operation application do not contain errors, throws if there are any.
     *
     * @param appliedOp Results of operation application.
     */
    function checkAppliedOperationResults(appliedOp: TezosTypes.AlphaOperationsWithMetadata[]): void {
        const validAppliedKinds = new Set(['activate_account', 'reveal', 'transaction', 'origination', 'delegation']);
        const firstAppliedOp = appliedOp[0]; // All our op groups are singletons so we deliberately check the zeroth result.

        if (firstAppliedOp.kind != null && !validAppliedKinds.has(firstAppliedOp.kind)) {
            log.error(`TezosNodeWriter.checkAppliedOperationResults failed with ${firstAppliedOp.id}`);
            throw new Error(`Could not apply operation because ${firstAppliedOp.id}`);
        }

        for (const op of firstAppliedOp.contents) {
            if (!validAppliedKinds.has(op.kind)) {
                log.error(`TezosNodeWriter.checkAppliedOperationResults failed with ${op.metadata}`);
                throw new Error(`Could not apply operation because: ${op.metadata}`);
            }
        }
    }

    /**
     * Injects an operation using the Tezos RPC client.
     *
     * @param {string} server Tezos node to connect to
     * @param {SignedOperationGroup} signedOpGroup Signed operation group
     * @returns {Promise<InjectedOperation>} ID of injected operation
     */
    export async function injectOperation(server: string, signedOpGroup: TezosTypes.SignedOperationGroup): Promise<string> {
        const response = await performPostRequest(server, 'injection/operation?chain=main', signedOpGroup.bytes.toString('hex'));
        const injectedOperation = await response.text();

        return injectedOperation;
    }

    /**
     * Master function for creating and sending all supported types of operations.
     * 
     * @param {string} server Tezos node to connect to
     * @param {Operation[]} operations The operations to create and send
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>}  The ID of the created operation group
     */
    export async function sendOperation(server: string, operations: TezosP2PMessageTypes.Operation[], keyStore: KeyStore, derivationPath): Promise<TezosTypes.OperationResult> {
        const blockHead = await TezosNodeReader.getBlockHead(server);
        const forgedOperationGroup = forgeOperations(blockHead.hash, operations);
        const signedOpGroup = await signOperationGroup(forgedOperationGroup, keyStore, derivationPath);
        const appliedOp = await applyOperation(server, blockHead.hash, blockHead.protocol, operations, signedOpGroup);
        checkAppliedOperationResults(appliedOp);
        const injectedOperation = await injectOperation(server, signedOpGroup);

        return { results: appliedOp[0], operationGroupID: injectedOperation };
    }

    /**
     * Helper function for sending Delegations, Transactions, and Originations. Checks if manager's public key has been revealed for operation. If yes, do nothing, else, bundle a reveal operation before the input operation.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} accountHash Account address to reveal.
     * @param {number} accountOperationIndex
     * @param {StackableOperation[]} operations Delegation, Transaction, or Origination to possibly bundle with a reveal
     */
    export async function appendRevealOperation(server: string, keyStore: KeyStore, accountHash: string, accountOperationIndex: number, operations: TezosP2PMessageTypes.StackableOperation[]) {
        const isKeyRevealed = await TezosNodeReader.isManagerKeyRevealedForAccount(server, accountHash);
        const counter = accountOperationIndex + 1;

        if (!isKeyRevealed) {
            const revealOp: TezosP2PMessageTypes.Reveal = {
                kind: 'reveal',
                source: accountHash,
                fee: '0', // Reveal Fee will be covered by the appended operation
                counter: counter.toString(),
                gas_limit: '10600',
                storage_limit: '0',
                public_key: keyStore.publicKey
            };

            operations.forEach((operation, index) => {
                const c: number = accountOperationIndex + 2 + index;
                operation.counter = c.toString();
            });

            return [revealOp, ...operations];
        }

        return operations;
    }

    /**
     * Creates and sends a transaction operation.
     * 
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {String} to Destination public key hash
     * @param {number} amount Amount to send
     * @param {number} fee Fee to use
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export async function sendTransactionOperation(server: string, keyStore: KeyStore, to: string, amount: number, fee: number, derivationPath: string = '') {
        const counter = await TezosNodeReader.getCounterForAccount(server, keyStore.publicKeyHash) + 1;

        const transaction: TezosP2PMessageTypes.Transaction = {
            destination: to,
            amount: amount.toString(),
            storage_limit: TezosConstants.DefaultTransactionStorageLimit + '',
            gas_limit: TezosConstants.DefaultTransactionGasLimit + '',
            counter: counter.toString(),
            fee: fee.toString(),
            source: keyStore.publicKeyHash,
            kind: 'transaction'
        };

        const operations = await appendRevealOperation(server, keyStore, keyStore.publicKeyHash, counter - 1, [transaction])

        return sendOperation(server, operations, keyStore, derivationPath);
    }

    /**
     * Creates and sends a delegation operation.
     * 
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} delegator Account address to delegate from
     * @param {string} delegate Account address to delegate to, alternatively, '' or undefined if removing delegation
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export async function sendDelegationOperation(server: string, keyStore: KeyStore, delegator: string, delegate: string | undefined, fee: number = TezosConstants.DefaultDelegationFee, derivationPath: string = '') { // TODO: constants
        const counter = await TezosNodeReader.getCounterForAccount(server, delegator) + 1;

        const delegation: TezosP2PMessageTypes.Delegation = {
            kind: 'delegation',
            source: delegator,
            fee: fee.toString(),
            counter: counter.toString(),
            storage_limit: TezosConstants.DefaultDelegationStorageLimit + '',
            gas_limit: TezosConstants.DefaultDelegationStorageLimit + '',
            delegate: delegate
        }
        const operations = await appendRevealOperation(server, keyStore, delegator, counter - 1, [delegation]);

        return sendOperation(server, operations, keyStore, derivationPath);
    }

    /**
     * Internally calls sendDelegationOperation with a blank delegate.
     * 
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} delegator Account address to delegate from
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export async function sendUndelegationOperation(server: string, keyStore: KeyStore, delegator: string, fee: number = TezosConstants.DefaultDelegationFee, derivationPath: string = '') {
        return sendDelegationOperation(server, keyStore, delegator, undefined, fee, derivationPath);
    }

    /**
     * Sends an account origination operation.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {number} amount Initial funding amount for the new account in uXTZ
     * @param {string} delegate Account address to delegate to, blank if none
     * @param {boolean} spendable Is the new account allowed to transact?
     * @param {boolean} delegatable Can the account be delegated?
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export async function sendAccountOriginationOperation(server: string, keyStore: KeyStore, amount: number, delegate: string | undefined, spendable: boolean, delegatable: boolean, fee: number = TezosConstants.DefaultAccountOriginationFee, derivationPath: string = '') {
        return sendOriginationOperation(server, keyStore, amount, delegate, spendable, delegatable, fee, derivationPath, TezosConstants.DefaultAccountOriginationStorageLimit, TezosConstants.DefaultAccountOriginationGasLimit);
    }

    /**
     * Sends a contract origination operation.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {number} amount Initial funding amount of new account
     * @param {string} delegate Account ID to delegate to, blank if none
     * @param {boolean} spendable Is account spendable?
     * @param {boolean} delegatable Is account delegatable?
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @param {string} storage_limit Storage fee
     * @param {string} gas_limit Gas limit
     * @param {string} code Contract code
     * @param {string} storage Initial storage value
     * @param {TezosParameterFormat} codeFormat Code format
     */
    export async function sendContractOriginationOperation(
        server: string,
        keyStore: KeyStore,
        amount: number,
        delegate: string | undefined,
        spendable: boolean,
        delegatable: boolean,
        fee: number,
        derivationPath: string,
        storage_limit: number,
        gas_limit: number,
        code: string,
        storage: string,
        codeFormat: TezosTypes.TezosParameterFormat = TezosTypes.TezosParameterFormat.Micheline
    ) {
        if (spendable) { log.warn('As of protocol 004-Pt24m4xi, contracts with code cannot be "spendable"'); }

        let parsedCode: any = undefined;
        let parsedStorage: any = undefined;

        if (codeFormat === TezosTypes.TezosParameterFormat.Michelson) {
            parsedCode = JSON.parse(TezosLanguageUtil.translateMichelsonToMicheline(code));
            log.debug(`TezosNodeWriter.sendOriginationOperation code translation:\n${code}\n->\n${JSON.stringify(parsedCode)}`);

            parsedStorage = JSON.parse(TezosLanguageUtil.translateMichelsonToMicheline(storage));
            log.debug(`TezosNodeWriter.sendOriginationOperation storage translation:\n${storage}\n->\n${JSON.stringify(parsedStorage)}`);
        } else if (codeFormat === TezosTypes.TezosParameterFormat.Micheline) {
            parsedCode = JSON.parse(code);
            parsedStorage = JSON.parse(storage); // TODO: handle empty storage
        }
   
        return sendOriginationOperation(server, keyStore, amount, delegate, spendable, delegatable, fee, derivationPath, storage_limit, gas_limit, parsedCode, parsedStorage);
    }

    /**
     * General purpose function for origination.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {number} amount Initial funding amount of new account
     * @param {string} delegate Account ID to delegate to or 'undefined'
     * @param {boolean} spendable Is account spendable?
     * @param {boolean} delegatable Is account delegatable?
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @param {string} storage_limit Storage fee.
     * @param {string} gas_limit Gas limit.
     * @param {object} code Contract code in Micheline format.
     * @param {object} storage Initial storage value in Micheline format.
     *
     * @returns {Promise<OperationResult>} Result of the operation
     */
    async function sendOriginationOperation(
        server: string,
        keyStore: KeyStore,
        amount: number,
        delegate: string | undefined,
        spendable: boolean,
        delegatable: boolean,
        fee: number,
        derivationPath: string,
        storage_limit: number,
        gas_limit: number,
        code?: object,
        storage?: object
    ) {
        const counter = await TezosNodeReader.getCounterForAccount(server, keyStore.publicKeyHash) + 1;

        const origination: TezosP2PMessageTypes.Origination = {
            kind: 'origination',
            source: keyStore.publicKeyHash,
            fee: fee.toString(),
            counter: counter.toString(),
            gas_limit: gas_limit.toString(),
            storage_limit: storage_limit.toString(),
            manager_pubkey: keyStore.publicKeyHash,
            balance: amount.toString(),
            spendable: spendable,
            delegatable: delegatable && !!delegate,
            delegate: delegate,
            script: code ? { code, storage } : undefined
        };
        const operations = await appendRevealOperation(server, keyStore, keyStore.publicKeyHash, counter - 1, [origination]);

        return sendOperation(server, operations, keyStore, derivationPath);
    }

    /**
     * Invokes a contract with desired parameters
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} to Contract address
     * @param {number} amount Initial funding amount of new account
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @param {string} storage_limit Storage fee
     * @param {string} gas_limit Gas limit
     * @param {string} parameters Contract arguments
     * @param {TezosParameterFormat} parameterFormat Contract argument format
     */
    export async function sendContractInvocationOperation(
        server: string,
        keyStore: KeyStore,
        to: string,
        amount: number,
        fee: number,
        derivationPath: string,
        storageLimit: number,
        gasLimit: number,
        parameters?: string,
        parameterFormat: TezosTypes.TezosParameterFormat = TezosTypes.TezosParameterFormat.Micheline
    ) {
        const counter = await TezosNodeReader.getCounterForAccount(server, keyStore.publicKeyHash) + 1;

        let transaction: TezosP2PMessageTypes.Transaction = {
            destination: to,
            amount: amount.toString(),
            storage_limit: storageLimit.toString(),
            gas_limit: gasLimit.toString(),
            counter: counter.toString(),
            fee: fee.toString(),
            source: keyStore.publicKeyHash,
            kind: 'transaction'
        };

        if (!!parameters && parameters.trim().length > 0) {
            if (parameterFormat === TezosTypes.TezosParameterFormat.Michelson) {
                const michelineParams = TezosLanguageUtil.translateMichelsonToMicheline(parameters);
                transaction.parameters = JSON.parse(michelineParams);
            } else if (parameterFormat === TezosTypes.TezosParameterFormat.Micheline) {
                transaction.parameters = JSON.parse(parameters);
            }
        }

        const operations = await appendRevealOperation(server, keyStore, keyStore.publicKeyHash, counter - 1, [transaction]);
        return sendOperation(server, operations, keyStore, derivationPath);
    }

    /**
     * Invokes a contract without parameters and a 0 amount.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} to Contract address
     * @param {number} fee Operation fee
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @param {string} storage_limit Storage fee
     * @param {string} gas_limit Gas limit
     * @param {string} parameters Contract arguments
     * @param {TezosParameterFormat} parameterFormat Contract argument format
     */
    export async function sendContractPing(server: string, keyStore: KeyStore, to: string, fee: number, derivationPath: string, storageLimit: number, gasLimit: number) {
        return sendContractInvocationOperation(server, keyStore, to, 0, fee, derivationPath, storageLimit, gasLimit, '');
    }

    /**
     * Creates and sends a reveal operation.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {number} fee Fee to pay
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export async function sendKeyRevealOperation(server: string, keyStore: KeyStore, fee: number = TezosConstants.DefaultKeyRevealFee, derivationPath: string = '') {
        const counter = await TezosNodeReader.getCounterForAccount(server, keyStore.publicKeyHash) + 1;

        const revealOp: TezosP2PMessageTypes.Reveal = {
            kind: 'reveal',
            source: keyStore.publicKeyHash,
            fee: fee + '',
            counter: counter.toString(),
            gas_limit: '10000',
            storage_limit: '0',
            public_key: keyStore.publicKey
        };
        const operations = [revealOp];

        return sendOperation(server, operations, keyStore, derivationPath)
    }

    /**
     * Creates and sends a fundraiser account activation operation.
     *
     * @param {string} server Tezos node to connect to
     * @param {KeyStore} keyStore Key pair along with public key hash
     * @param {string} activationCode Activation code provided by fundraiser process
     * @param {string} derivationPath BIP44 Derivation Path if signed with hardware, empty if signed with software
     * @returns {Promise<OperationResult>} Result of the operation
     */
    export function sendIdentityActivationOperation(server: string, keyStore: KeyStore, activationCode: string, derivationPath: string) {
        const activation = { kind: 'activate_account', pkh: keyStore.publicKeyHash, secret: activationCode };

        return sendOperation(server, [activation], keyStore, derivationPath);
    }
}

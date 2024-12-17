import express from 'express';
import axios from 'axios';
import request from 'request';
import { ethers } from 'ethers'
import { Buffer } from 'buffer';
import { webln as providers } from "@getalby/sdk";

import 'websocket-polyfill'
import cors from 'cors';


import { Firestore } from '@google-cloud/firestore';

import { v4 as uuidv4 } from 'uuid';


import dotenv from 'dotenv';

import bolt11 from './bolt11.js';


dotenv.config({ path: './.env' });

const app = express();

const firestoreCredentials = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
};

const db = new Firestore({
  projectId: firestoreCredentials.projectId,
  credentials: {
    client_email: firestoreCredentials.clientEmail,
    private_key: firestoreCredentials.privateKey,
  },
});





app.use(express.json());
app.use(cors())


let rpcNodes = {};

const getRpcNodes = async () => {
  const url = `https://chainid.network/chains.json`;
  let options = {    // Work-around for self-signed certificates.
    rejectUnauthorized: false,
    json: true
  }
  const response = await axios.get(url, options);
  const body = response.data;
  body.map(item => {
    const rpcsInfura = item.rpc.filter(rpc => {return  rpc.indexOf("${INFURA_API_KEY}") !== -1});
    const rpcsAlchemy = item.rpc.filter(rpc => {return  rpc.indexOf("${ALCHEMY_API_KEY}") !== -1});
    if (rpcsInfura[0]) {
      rpcNodes[Number(item.chainId)] = rpcsInfura[0].replace("${INFURA_API_KEY}", process.env.INFURA_API_KEY);
    } else if(rpcsAlchemy[0]){
      rpcNodes[Number(item.chainId)] = rpcsAlchemy[0].replace("${ALCHEMY_API_KEY}", process.env.ALCHEMY_API_KEY);
    } else if(item.rpc[0]){
      rpcNodes[Number(item.chainId)] = item.rpc[0].replace("${INFURA_API_KEY}", process.env.INFURA_API_KEY).replace("${ALCHEMY_API_KEY}", process.env.ALCHEMY_API_KEY);
    }
  });
  console.log(`Got total of ${Object.keys(rpcNodes).length} rpc nodes`);
  console.log(`RPC node goerli: 0x05 - ${rpcNodes[0x05]}`);
  console.log(`RPC node sepolia: 0xaa36a7 - ${rpcNodes[0xaa36a7]}`);
  console.log(`RPC node rsk testnet: 0x1f - ${rpcNodes[0x1f]}`);

  return (rpcNodes);
};


const ongoingRequests = new Map();


app.use(async (req, res, next) => {
  try {
    const requestId = uuidv4(); // Generate a unique identifier for the request+
    console.log(`Request ID: ${requestId} - Received request from IP: ${req.ip}, Path: ${req.path}, Method: ${req.method}`);


    const idempotencyKey = req.headers['idempotency-key'];
    console.log(`Request ID: ${requestId} - Idempotency Key:`, idempotencyKey);

    if (idempotencyKey) {
      const doc = await db.collection('test').doc(idempotencyKey).get();

      if (doc.exists) {
        console.log(`Request ID: ${requestId}  --Request already processed, returning stored response`);
        return res.json(doc.data().responseData); // Return the stored response
      } else if (ongoingRequests.has(idempotencyKey)) {
        console.log(`Request ID: ${requestId} -- Duplicate request detected, waiting for a bit before re-checking Firestore`);

        setTimeout(async () => {
          const docAfterWait = await db.collection('test').doc(idempotencyKey).get();
          if (docAfterWait.exists) {
            console.log('Found stored response after waiting');
            return res.json(docAfterWait.data().responseData);
          } else {
            console.log(`Request ID: ${requestId} -- No stored response found after waiting, proceeding to handle request`);
            // You might want to handle this case depending on your application's needs
          }
        }, 2000);  // Wait for 500ms before re-checking

        return; // Exit the current execution to wait
      } else {
        const ongoingRequest = new Promise((resolve, reject) => {
          req.on('end', resolve);
          req.on('error', reject);
        });
        ongoingRequests.set(idempotencyKey, ongoingRequest);
      }

      const { json: originalJson } = res;
      res.json = function (body) {
        originalJson.call(this, body);


        console.log(`Response body for: ${requestId} `, body);

        // if (res.statusCode === 200) {
        const data = {
          idempotencyKey,
          responseData: body,
        };

        db.collection('test')
          .doc(idempotencyKey)
          .set(data)
          .then(() => {
            console.log(`Request ID: ${requestId} -- Data stored in Firestore `);
            ongoingRequests.delete(idempotencyKey);
          })
          .catch((error) => console.error('Error storing data in Firestore:', error));
        // }
      };
    }

    next();
  } catch (error) {
    console.error('Error in middleware:', error);
    res.status(500).json({ error: 'An error occurred while processing the request' });
  }
});




// Test Route
app.get('/', async (req, res) => {
  try {
    rpcNodes = await getRpcNodes();
    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.getInfo();
      
    webln.close();
    res.json(response);
  } catch (err) {
    res.json(err)
  }
  return;
});

app.get('/v1/payreq/:payment_request', async (req, res) => {
  try {
    // Verify if request comes from icp canister

    //const signatureBase = "0x" + req.headers.signature;
    const payment_request = req.params.payment_request;
    const response = bolt11.decode(payment_request)

    res.json(response);

  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).json(err)
  }
  return;
});

app.post('/v1/invoices', async (req, res) => {

  //const { value: amount, memo: evm_addr } = req.body;  // Updated this line
  const amount = req.body.value;
  const evm_addr = req.body.memo;
  console.log("Request for invoice creation with amount " + amount + " and memo " + evm_addr);
  // Validate that amount and evm_addr are defined
  if (!amount || !evm_addr) {
    res.status(400).json({ error: 'Both amount and evm_addr are required' });
    return;
  }

  // Validate the type of amount
  if (typeof amount !== 'number' && typeof amount !== 'string') {
    res.status(400).json({ error: 'Invalid type for amount' });
    return;
  }

  try{
    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.makeInvoice({
      amount: amount, // in sats
      defaultMemo: evm_addr,
    });
    
    console.info(response);
    
    webln.close();
    res.json(response);
  } catch(err){
    res.status(500).json(err)
  }

});


app.get('/v2/invoices/lookup', async (req, res) => {
  try {
    const invoiceOrPaymentHash = req.query.payment_hash;

    if (!invoiceOrPaymentHash) {
      res.status(400).send({ "error": "payment_hash is required" });
      return;
    }

    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.lookupInvoice({
      // provide one of the below
      paymentRequest: invoiceOrPaymentHash.startsWith("ln")
        ? invoiceOrPaymentHash
        : undefined,
      paymentHash: !invoiceOrPaymentHash.startsWith("ln")
        ? invoiceOrPaymentHash
        : undefined,
    });
    
    console.info(response);
    
    webln.close();
    res.json(response);
  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).json(err);
  }
  return;
});


app.get('/v1/getinfo', async (req, res) => {

  try{
    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.getInfo();
    
    console.info(response);
    
    webln.close();
    res.json(response);
  } catch(err){
    res.status(500).json(err);
  }
});

app.get('/v1/balance/channels', async (req, res) => {
  try{
    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.getBalance();
    
    console.info(response);
    
    webln.close();
    res.json(response);
  } catch(err){
    res.status(500).json(err);
  }
});


app.post('/getContractAddressWBTC', (req, res) => {

  const chainIdHex = req.headers['chain-id'];
  const chainId = parseInt(chainIdHex, 16).toString();

  // Example mapping of chainId to WBTC contract addresses
  const contractAddressesWBTCn = {
    '1': '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // Ethereum Mainnet
    '8453': '0x1ceA84203673764244E05693e42E6Ace62bE9BA5', // Base
    '2222': '0xD359A8549802A8122C4cfe5d84685e347E22E946', // Kava
    '11155111': '0x0311FC95124Ca345a3913b6133028Ac8DEe47AA5' // Sepolia
  };

  const contractAddress = contractAddressesWBTCn[chainId];

  if (contractAddress) {
    res.json({ contractAddress });
  } else {
    res.status(404).json({ error: 'Contract address not found for the given chainId' });
  }
});


// Post to pay invoice to user, verify conditions firts (must come from canister)
app.post('/payInvoice', async (req, res) => {
  try {

    // Verify if request comes from icp canister

    const signatureBase = "0x" + req.headers.signature;
    let message = req.body.payment_request;
    console.log(`Invoice to be paid: ${message}`);

    //message = message.substring(message.indexOf("lntb"), message.length - 1);
    const messageHash = ethers.utils.keccak256(Buffer.from(message));

    message = message.substring(message.indexOf("lntb"), message.length);
    console.log(`Preparing to check ${message}`)
    // Define a list of expected addresses
    const expectedAddresses = [
      '0x492d553f456231c67dcd4a0f3603b3b1f2918a95'.toLowerCase(),
      '0xc5acf85fedb04cc84789e5d84c0dfcb74388c157'.toLowerCase(),
      '0xeafdc02a5341a7b2542056a85b77a8db09a71fe9'.toLowerCase(),
      '0xf86f2aa698732a9b00511b61f348981076e447b8'.toLowerCase(),
      '0x3cca770bbe348cfc53e3b6348c18363a14cf1d38'.toLowerCase(),
      '0xc58b5996da0dfc22c821adf8eefd3bf0da767f6d'.toLowerCase(),
      '0x406987a57d923f34e4f4618c3337dd5f51faf06f'.toLowerCase()


      // ... add more addresses as needed
    ];

    // Try both possible v values for chain ID 31
    const vValues = ['59', '5a'];
    let isValidSignature = false;
    let recoveredAddress;

    vValues.forEach(v => {
      try {
        const fullSignature = signatureBase + v;
        recoveredAddress = ethers.utils.recoverAddress(messageHash, ethers.utils.splitSignature(fullSignature));
        console.log("address: ", recoveredAddress.toLowerCase());

        if (expectedAddresses.includes(recoveredAddress.toLowerCase())) {
          isValidSignature = true;
        }
      } catch (error) {
        console.error(`Error recovering address with v = 0x${v}:`, error);
      }
    });

    if (!isValidSignature) {

      console.error("invalid signature");

      res.json({
        message: "Invalid signature"
      });
      return;
    }

    const webln = new providers.NostrWebLNProvider({
      nostrWalletConnectUrl: process.env.NWC_URI,
    });
    await webln.enable();
    const response = await webln.sendPayment(message);
    
    console.info(response);
    
    webln.close();
    res.json(response);

  } catch (err) {
    console.log("ERROR:", err);
    res.json(err)
  }
  return;
});


app.post('/payBlockchainTx', async (req, res) => {

  try {
    if (Object.keys(rpcNodes).length == 0) {
      rpcNodes = await getRpcNodes();
    }
    console.log(req.body)
    const sendTxPayload = req.body;
    const chainId = req.headers['chain-id'];

    console.log("chainIdHex!:", chainId)

    let chainIdInt = parseInt(chainId, 16);



    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));


    const nodeUrl = rpcNodes[Number(chainIdInt)];

    console.log("Using RPC Node:", nodeUrl);
    if (!nodeUrl) {
      res.status(500).json({ error: 'EVM chain not supported' });
      return;
    }
    const options = {
      url: nodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }
      console.log("response", JSON.parse(body));

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});


app.post('/getEvents', (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));

    let chainIdInt = parseInt(chainId, 16);

    const nodeUrl = rpcNodes[Number(chainIdInt)];

    console.log("Using RPC Node:", nodeUrl);
    if (!nodeUrl) {
      res.status(500).json({ error: 'EVM chain not supported' });
      return;
    }
    const options = {
      url: nodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }

      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
  }
});



app.post('/interactWithNode', async (req, res) => {
  try {
    const sendTxPayload = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    const chainId = req.headers['chain-id'];

    console.log("chainIdHex!:", chainId)

    let chainIdInt = parseInt(chainId, 16);

    //Chain Id is hexadecimal converting to

    console.log('Idempotency Key:', idempotencyKey);
    console.log('Sending tx:', JSON.stringify(sendTxPayload));

    console.log(sendTxPayload.chainId)
    if (Object.keys(rpcNodes).length == 0) {
      rpcNodes = await getRpcNodes();
    }
    const nodeUrl = rpcNodes[Number(chainIdInt)];

    console.log("Using RPC Node:", nodeUrl);
    if (!nodeUrl) {
      res.status(500).json({ error: 'EVM chain not supported' });
      return;
    }
    const options = {
      url: nodeUrl,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(sendTxPayload)
    };

    request.post(options, (error, response, body) => {
      if (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing the transaction' });
        return;
      }
      console.log(body);
      console.log('Transaction processed, returning response to client');
      res.json(JSON.parse(body));
      return
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while processing the transaction' });
    return
  }
});

app.listen(process.env.PORT ? process.env.PORT : 8080, () => {
  console.log(`Service initiated at port ${process.env.PORT ? process.env.PORT : 8080}`)
});

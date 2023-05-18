import express from "express";
import assert from "assert";
import { v4 as uuidv4 } from 'uuid';


import {GraphData, address0, NodeDataStore, DagVote, joinTree, changeName,  addDagVote, removeDagVote, leaveTree, switchPositionWithParent, moveTreeVote} from "./dagBase";
import {calculateDepthAndRelRoot, calculateReputation, findRandomLeaf} from "./dagProcessing";
import {loadAnthillGraph} from "./dagLoading";

const http = require('http');
const {Server} = require('ws');


/////////////////////////////////////////

// Spinning the http exress server and the WebSocket server on the same port.
const app = express();

const server = http.createServer(app, {trustProxy: true});
const wsServer = new Server({ server });

let port = process.env.PORT;

if(port == null || port == "") {
  port = "5000";
}

server.listen(port, () => {
  console.log(`WebSocket and http server is running on port ${port}`);
  crawlEthereum(testing);
});


// I'm maintaining all active connections in this object
var clients : {[id : string] : WebSocket} ={} ;

// A new client connection request received
wsServer.on('connection', function connection(ws) {

    // Generate a unique code for every user
    const userId = uuidv4();
    console.log(`Recieved a new connection.`);

    // Store the new connection and handle messages
    clients[userId] = ws;
    ws.uid = userId;

    console.log(`${userId} connected.`);

    ws.on('message', function incoming(message) {
        console.log('received: %s', message);
    })

    ws.send(JSON.stringify({
        anthillGraph: anthillGraphServe, 
        anthillGraphNum: anthillGraphNumServe,
        anthillRootId: anthillRootIdServe,
        randomLeaf: randomLeafServe
    }));
});

//////////////////////////////

var anthillGraphServe = {} as GraphData;  
var anthillGraphNumServe =0;    

var anthillRootIdServe = address0;
var randomLeafServe = address0;


function broadcastState() {
  wsServer.clients.forEach((client:any) => {
      client.send(JSON.stringify({
        anthillGraph: anthillGraphServe, 
        anthillGraphNum: anthillGraphNumServe,
        anthillRootId: anthillRootIdServe,
        randomLeaf: randomLeafServe
      }));
  });
}

function replaceServe(){

  anthillGraphServe = anthillGraph;
  anthillGraphNumServe = anthillGraphNum;
  anthillRootIdServe = anthillRootId;
  randomLeafServe = randomLeaf;

  broadcastState();
}

// web3
var Web3 = require('web3');
var providerURL : string; 
var anthillContractAddress: string;

const testing = false;

if (testing) {
     providerURL = "ws://localhost:8545";

     anthillContractAddress = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" // forge with lib
    // const anthillContractAddress ="0x5fbdb2315678afecb367f032d93f642f64180aa3" // forge without lib

} else {
    providerURL = "wss://polygon-testnet.blastapi.io/88fd2015-7a3d-4ea1-a72d-34144c92d931"

    anthillContractAddress = "0x69649a6E7E9c090a742f0671C64f4c7c31a1e4ce" // mumbai v4
    // anthillContractAddress = "0xb2218969ECF92a3085B8345665d65FCdFED9F981" // mumbai v3
    // const anthillContractAddress = "0x7b7D7Ea1c6aBA7aa7de1DC8595A9e839B0ee58FB" // mumbai v2
    // const anthillContractAddress = "0xE2C8d9C92eAb868C6078C778f12f794858147947" // mumbai v1
}

var options = {
    reconnect: {
        auto: true,
        delay: 60000, // ms
        maxAttempts: 5,
        onTimeout: false
    }
};

var web3 = new Web3(new Web3.providers.WebsocketProvider(providerURL, options));

// contract


var fs = require('fs');
var jsonFile = "./Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, anthillContractAddress);


// types
export type NodeData = {"id":string, "name":string, "totalWeight":number;  "currentRep": number, "depth":number,  "relRoot":string,  "sentTreeVote": string, "recTreeVotes":string[], "sentDagVotes":DagVote[], "recDagVotes": DagVote[]}

export type NodeDataBare = {"id":string, "name":string,  "totalWeight":number;  "currentRep": number, "depth":number, "relRoot":string, "sentTreeVote": string, "recTreeVotes": string []}

var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var anthillGraphNum =0;
var maxRelRootDepth = 6;
var anthillRootId = address0;
var randomLeaf =    address0;

async function crawlEthereum(testing: boolean) {
    console.log("loading graph (slowest part)")
    await loadAnthillGraph(anthillGraph, anthillGraphByDepth, anthillGraphNum, AnthillContract, testing)
    console.log("calculating depth")
    calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
    console.log("calculating reputation")
    calculateReputation(anthillGraph, anthillGraphByDepth);
    console.log("finding random leaf")
    randomLeaf = findRandomLeaf(anthillGraph);
    console.log("the found random leaf is: ", randomLeaf)
    replaceServe();

    // start subscription
    web3.eth.subscribe('logs', {"address": anthillContractAddress},
         async function(error:any, result:any){ 
            if (!error){

                // for testing we copy 
                // var anthillGraphCopy = (JSON.parse(JSON.stringify(anthillGraph))) as GraphData;
                // var anthillGraphByDepthCopy = [[]] as string[][]; 

                // assert (deepEqual(anthillGraph, anthillGraphCopy))
                // console.log("copy sanity check passed")

                // anthillGraphCopy.dict["0x0000000000000000000000000000000000000004"].recDagVotes[0][1][0].posInOther= 7; 
                // assert (deepEqual(anthillGraph, anthillGraphCopy)==false)
                // console.log("copy sanity check 2 passed")

                if (result.topics[0] == web3.eth.abi.encodeEventSignature("joinTreeEvent(address,string,address)")){
                    var {'0' :voter, '1':name, '2': recipient} =web3.eth.abi.decodeParameters(['address', 'string', 'address'], result.data);
                    console.log("joinTreeEvent", voter, name, recipient)
                    joinTree(anthillGraph, voter, name, recipient);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("changeNameEvent(address,string)")){

                    var {'0' :voter, '1':newName} =web3.eth.abi.decodeParameters(['address', 'string'], result.data);
                    console.log("changeNameEvent", voter, newName)
                    changeName(anthillGraph, voter, newName);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("addDagVoteEvent(address,address,uint32)")){

                    var {'0' :voter, '1':recipient, '2': weight} =web3.eth.abi.decodeParameters(['address', 'address', 'uint32'], result.data);
                    console.log("addDagVoteEvent", voter, recipient, weight )
                    addDagVote(anthillGraph, voter, recipient, parseInt(weight));

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("removeDagVoteEvent(address,address)")){

                    var {'0' :voter, '1':recipient}  =web3.eth.abi.decodeParameters(['address', 'address'], result.data);
                    console.log("removeDagVote", voter, recipient)
                    removeDagVote(anthillGraph, voter, recipient);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("leaveTreeEvent(address)")){

                    var {'0' :voter} =web3.eth.abi.decodeParameters(['address'], result.data);
                    console.log("leaveTreeEvent", voter)
                    leaveTree(anthillGraph, voter);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("switchPositionWithParentEvent(address)")){

                    var {'0' :voter} =web3.eth.abi.decodeParameters(['address',], result.data);
                    console.log("switchPositionWithParentEvent", voter)
                    switchPositionWithParent(anthillGraph, voter);

                } else if (result.topics[0] == web3.eth.abi.encodeEventSignature("moveTreeVoteEvent(address,address)")){

                    var {'0' :voter, '1': recipient} =web3.eth.abi.decodeParameters(['address', 'address'], result.data);
                    console.log("moveTreeVoteEvent", voter, recipient)
                    moveTreeVote(anthillGraph, voter, recipient);

                } 

                anthillGraphByDepth = [[]] as string[][];

                
                
                calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
                calculateReputation(anthillGraph, anthillGraphByDepth);
                
                // for testing
                // await loadAnthillGraph(anthillGraphCopy, anthillGraphByDepthCopy, anthillGraphNum, AnthillContract);

                // calculateDepthAndRelRoot(anthillGraphCopy, anthillGraphByDepthCopy);
                // calculateReputation(anthillGraphCopy, anthillGraphByDepthCopy);

                // console.log("asserting")

                // console.log( JSON.stringify(anthillGraph))
                // console.log( JSON.stringify(anthillGraphCopy))

                // assert (deepEqual(anthillGraph, anthillGraphCopy));
                // console.log("testing assert success")
                
                findRandomLeaf(anthillGraph);
                anthillGraphNum +=1;

                replaceServe();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
}

// used for testing 
// function deepEqual(x:any, y:any):boolean {
//     const ok = Object.keys, tx = typeof x, ty = typeof y;
//     return x && y && tx === 'object' && tx === ty ? (
//       ok(x).length === ok(y).length &&
//         ok(x).every(key => deepEqual(x[key], y[key]))
//     ) : (x === y);
//   }

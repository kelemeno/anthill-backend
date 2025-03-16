import express from "express";
import assert from "assert";
import { v4 as uuidv4 } from "uuid";

// import Quote from 'inspirational-quotes';

import {
  GraphData,
  address0,
  NodeDataStore,
  DagVote,
  DagVoteString,
  joinTree,
  changeName,
  addDagVote,
  removeDagVote,
  leaveTree,
  switchPositionWithParent,
  moveTreeVote,
  dagVoteString,
} from "./dagBase";
import {
  calculateDepthAndRelRoot,
  calculateReputation,
  findRandomLeaf,
} from "./dagProcessing";
import { loadAnthillGraph } from "./dagLoading";
import { Anthill__factory } from "./typechain";
import { ethers, JsonRpcApiProviderOptions } from "ethers";

// import WebSocket, { WebSocketServer as WSWebSocketServer } from 'ws';

const http = require("http");
const { Server } = require("ws");

/////////////////////////////////////////

// Spinning the http exress server and the WebSocket server on the same port.
const app = express();

const server = http.createServer(app, { trustProxy: true });
// const WebSocketServer = WebSocket.Server || WSWebSocketServer;
// const wsServer = new WebSocketServer({ server: server, clientTracking: true });

const wsServer = new Server({ server });

let port = process.env.PORT;

if (port == null || port == "") {
  port = "5001";
}

server.listen(port, () => {
  console.log(`WebSocket and http server is running on port ${port}`);
  crawlEthereum(testing);
});

// I'm maintaining all active connections in this object
var clients: { [id: string]: string } = {};

// A new client connection request received
wsServer.on("connection", function connection(ws: any, req: any) {
  // Generate a unique code for every user
  const userId = uuidv4();
  console.log(`Recieved a new connection.`);

  // Store the new connection and handle messages
  clients[userId] = ws;
  ws.uid = userId;

  console.log(`${userId} connected.`);

  ws.on("message", function incoming(message: any) {
    console.log("received: %s", message);
  });
  ws.on("error", (err: any) => {
    console.log(err.stack);
  });

  ws.send("Hello from the server");
});

//////////////////////////////
////// serve

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});

app.use((err: any, req: any, res: any, next: any) => {
  res.locals.error = err.response.data;
  const status = err.status || 500;
  res.status(status);
  res.render("error");
});

app.get("/maxRelRootDepth", function (req, res) {
  console.log("getting max rel root");
  res.send({ maxRelRootDepth: maxRelRootDepth });
});

app.get("/rootId", function (req, res) {
  console.log("getting root");
  res.send({ id: anthillRootIdServe });
});

app.get("/isNodeInGraph/:id", function (req, res) {
  console.log("isNodeInGraph", req.params.id);
  if (anthillGraphServe.dict[req.params.id] === undefined) {
    res.send({ isNodeInGraph: false });
  } else {
    res.send({ isNodeInGraph: true });
  }
});

// app.get("/anthillGraphNum", function(req, res) {
//     // console.log("getting anthillGraphNum")
//     res.send({"anthillGraphNum": anthillGraphNumServe});
// });

app.get("/id/:id", function (req, res) {
  console.log("Getting id: ", req.params.id);
  if (
    req.params.id === "undefined" ||
    req.params.id === undefined ||
    anthillGraphServe.dict[req.params.id] === undefined
  ) {
    res.status(404).send({ message: "User not found" });
  } else {
    res.send({
      nodeData: NodeDataStoreCollapse(anthillGraphServe.dict[req.params.id]),
    });
  }
});

app.get("/bareId/:id", function (req, res) {
  console.log("Getting bare id: ", req.params.id);
  // console.log("displaying: ", anthillGraphServe[req.params.id])
  var nodeData = anthillGraphServe.dict[req.params.id];

  res.send({ nodeData: NodeDataBareCollapse(nodeData) });
});

app.get("/randomLeaf", function (req, res) {
  console.log("getting random leaf");

  res.send({ randomLeaf: randomLeafServe });
});

// let port = process.env.PORT;

// if(port == null || port == "") {
//     port = "5001";
// }

// // using the same port as ws, so redundunt
// app.listen(port, function() {
//     console.log("Server started successfully");
//     // console.log("Crawling ethereum for data");
//     // crawlEthereum();

// });

/////////////////////////////////////////

var anthillGraphServe = {} as GraphData;
var anthillGraphNumServe = 0;

var anthillRootIdServe = address0;
var randomLeafServe = address0;

function replaceServe() {
  anthillGraphServe = anthillGraph;
  anthillGraphNumServe = anthillGraphNum;
  anthillRootIdServe = anthillRootId;
  randomLeafServe = randomLeaf;

  wsServer.clients.forEach((client: any) => {
    client.send("update");
  });
}

function NodeDataStoreCollapse(node: NodeDataStore): NodeDataString {
  var nodec = {} as NodeDataString;
  nodec.id = node.id;
  nodec.name = node.name;

  nodec.depth = node.depth;
  nodec.currentRep = node.currentRep.toString();
  nodec.relRoot = node.relRoot;

  nodec.totalWeight = node.totalWeight.toString();
  nodec.sentTreeVote = node.sentTreeVote;
  nodec.recTreeVotes = node.recTreeVotes;

  nodec.sentDagVotes = [] as DagVoteString[];
  nodec.recDagVotes = [] as DagVoteString[];

  node.recDagVotes.forEach((rDagVote) => {
    nodec.recDagVotes.push(dagVoteString(rDagVote));
  });

  node.sentDagVotes.forEach((sDagVote) => {
    nodec.sentDagVotes.push(dagVoteString(sDagVote));
  });

  return nodec;
}

//////////////////////
///// Load

// web3
var providerURL: string;
var anthillContractAddress: string;

const testing = true;

if (testing) {
   providerURL = "ws://localhost:8545";
  // providerURL = "ws://127.0.0.1:3051"; // zksync test node

  // anthillContractAddress = "0x111C3E89Ce80e62EE88318C2804920D4c96f92bb"; // zk forge with lib
  //  anthillContractAddress = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" // forge with lib
  anthillContractAddress ="0x5fbdb2315678afecb367f032d93f642f64180aa3" // forge without lib
} else {
  providerURL = "wss://sepolia.era.zksync.dev/ws";

  anthillContractAddress = "0xe42923350EF3a534f84bb101453D9B442d42Bf0c"; // zksync sepolia
}

const options: JsonRpcApiProviderOptions = {
  polling: true,
  staticNetwork: null,
  batchStallTime: 60000, // ms
  batchMaxSize: 5,
  cacheTimeout: 60000,
  pollingInterval: 60000
};

// var web3 = new Web3(new Web3.providers.WebsocketProvider(providerURL, options));
const webSocketProvider = new ethers.WebSocketProvider(providerURL,undefined, options);

// contract

let AnthillContract = Anthill__factory.connect(
  anthillContractAddress,
  webSocketProvider
);

// types
export type NodeData = {
  id: string;
  name: string;
  totalWeight: bigint;
  currentRep: bigint;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
  sentDagVotes: DagVote[];
  recDagVotes: DagVote[];
};

export type NodeDataString = {
  id: string;
  name: string;
  totalWeight: string;
  currentRep: string;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
  sentDagVotes: DagVoteString[];
  recDagVotes: DagVoteString[];
};

export type NodeDataBare = {
  id: string;
  name: string;
  totalWeight: bigint;
  currentRep: bigint;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
};

export type NodeDataBareString = {
  id: string;
  name: string;
  totalWeight: string;
  currentRep: string;
  depth: number;
  relRoot: string;
  sentTreeVote: string;
  recTreeVotes: string[];
};

function NodeDataBareCollapse(node: NodeDataBare): NodeDataBareString {
  var nodec = {} as NodeDataBareString;
  nodec.id = node.id;
  nodec.name = node.name;
  nodec.totalWeight = node.totalWeight.toString();
  nodec.currentRep = node.currentRep.toString();
  nodec.depth = node.depth;
  nodec.relRoot = node.relRoot;
  nodec.sentTreeVote = node.sentTreeVote;
  nodec.recTreeVotes = node.recTreeVotes;
  return nodec;
}

var anthillGraph = {} as GraphData;
var anthillGraphByDepth = [[]] as string[][];
var anthillGraphNum = 0;
var maxRelRootDepth = 6;
var anthillRootId = address0;
var randomLeaf = address0;

async function crawlEthereum(testing: boolean) {
  console.log("Loading graph (slowest part)");
  await loadAnthillGraph(
    anthillGraph,
    anthillGraphByDepth,
    anthillGraphNum,
    AnthillContract,
    testing,
  );
  console.log("Calculating depth");
  calculateDepthAndRelRoot(anthillGraph, anthillGraphByDepth);
  console.log("Calculating reputation");
  calculateReputation(anthillGraph, anthillGraphByDepth);
  console.log("Finding random leaf");
  randomLeaf = findRandomLeaf(anthillGraph);
  console.log("The found random leaf is: ", randomLeaf);
  replaceServe();

  // start subscription
  webSocketProvider.on(
    {
      address: anthillContractAddress,
      topics: []
    },
    async (log) => {
      console.log("received something");

      if (log) {
        console.log("received a non error");

        // for testing we copy
        // var anthillGraphCopy = (JSON.parse(JSON.stringify(anthillGraph))) as GraphData;
        // var anthillGraphByDepthCopy = [[]] as string[][];

        // assert (deepEqual(anthillGraph, anthillGraphCopy))
        // console.log("copy sanity check passed")

        // anthillGraphCopy.dict["0x0000000000000000000000000000000000000004"].recDagVotes[0][1][0].posInOther= 7;
        // assert (deepEqual(anthillGraph, anthillGraphCopy)==false)
        // console.log("copy sanity check 2 passed")

        if (
          log.topics[0] ==
          ethers.id(
            "JoinTreeEvent(address,string,address)"
          )
        ) {
          const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "string", "address"],
            log.data
          );
          const [voter, name, recipient] = decodedData;
          console.log("joinTreeEvent", voter, name, recipient);
          joinTree(anthillGraph, voter, name, recipient);
        } else if (
          log.topics[0] ==
          ethers.id("ChangeNameEvent(address,string)")
        ) {
          const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "string"],
            log.data
          );
          const [voter, newName] = decodedData;
          console.log("changeNameEvent", voter, newName);
          changeName(anthillGraph, voter, newName);
        } else if (
          log.topics[0] ==
          ethers.id(
            "AddDagVoteEvent(address,address,uint256)"
          )
        ) {
          const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "address", "uint256"],
            log.data
          );
          const [voter, recipient, weight] = decodedData;
          console.log("addDagVoteEvent", voter, recipient, weight);
          addDagVote(anthillGraph, voter, recipient, weight);
        } else if (
          log.topics[0] ==
          ethers.id(
            "RemoveDagVoteEvent(address,address)"
          )
        ) {
          const [voter, recipient]= ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "address"],
            log.data
          );
          console.log("removeDagVote", voter, recipient);
          removeDagVote(anthillGraph, voter, recipient);
        } else if (
          log.topics[0] ==
          ethers.id("LeaveTreeEvent(address)")
        ) {
          const [voter] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address"],
            log.data
          );
          console.log("leaveTreeEvent", voter);
          leaveTree(anthillGraph, voter);
        } else if (
          log.topics[0] ==
          ethers.id(
            "SwitchPositionWithParentEvent(address)"
          )
        ) {
          const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address"],
            log.data
          );
          const [voter] = decodedData;
          console.log("switchPositionWithParentEvent", voter);
          switchPositionWithParent(anthillGraph, voter);
        } else if (
          log.topics[0] ==
          ethers.id(
            "MoveTreeVoteEvent(address,address)"
          )
        ) {
          const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "address"],
            log.data
          );
          const [voter, recipient] = decodedData;
          console.log("moveTreeVoteEvent", voter, recipient);
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
        anthillGraphNum += 1;

        replaceServe();
      } else {
        console.log("we had some error in the eth subscription!", log.error);
      }
    },
  );
}

// used for testing
// function deepEqual(x:any, y:any):boolean {
//     const ok = Object.keys, tx = typeof x, ty = typeof y;
//     return x && y && tx === 'object' && tx === ty ? (
//       ok(x).length === ok(y).length &&
//         ok(x).every(key => deepEqual(x[key], y[key]))
//     ) : (x === y);
//   }

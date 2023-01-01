import express from "express";
// import Quote from 'inspirational-quotes';


const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});


app.get("/root", function(req, res) {
   
    res.send(anthillGraph[anthillRootId()]);
});    

app.get("/relRootDepth", function(req, res) {
   
    res.send(relRootDepth);
});

app.get("/id/:id", function(req, res) {
 
    res.send(anthillGraph[req.params.id]);

});

let port = process.env.PORT;

if(port == null || port == "") {
 port = "5000";
}

app.listen(port, function() {
    console.log("Server started successfully");
    console.log("Crawling ethereum for data");
    crawlEthereum();
    console.log("Finished crawling ethereum for data");

    getAnthillRelRootDepth();
});


//////////////////////

// web3
var Web3 = require('web3');
const anvilUrl = "http://localhost:8545";
var web3 = new Web3(anvilUrl);

// contract
const antHillContractAddress = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
var fs = require('fs');
var jsonFile = "../anthill/out/Anthill.sol/Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, antHillContractAddress);


// types
type GraphData= {[id: string]: NodeData;}
type NodeData = {"id":string, "name":string, "parentIds":string[], "treeParentId": string, "childIds":string[], }

var anthillGraph = {} as GraphData;
var relRootDepth = 6;


function anthillRootId() {
    // we will need to add a method in the smart contract to get the root id
    return "0x0000000000000000000000000000000000000002";
}


async function getAnthillRelRootDepth() {
    const res = await AnthillContract.methods.readRelRootDepth().call();
    relRootDepth = res;
    
}

async function loadDagVotes(id : string) : Promise<string[]>{
    var dagVotes= [];
    
    var sentDagVoteDiffString = await AnthillContract.methods.readSentDagVoteDiff(id).call();
    var sentDagVoteDiff = parseInt(sentDagVoteDiffString);
    var sentDagVoteCountString="" ;


    for (var i = 0; i < relRootDepth; i++) {
        sentDagVoteCountString  = await AnthillContract.methods.readSentDagVoteCount(id, i+sentDagVoteDiff).call();
        for (var j= 0; j< parseInt(sentDagVoteCountString); j++){
            var childId = await AnthillContract.methods.readSentDagVote(id, i+sentDagVoteDiff, j).call();
            dagVotes.push(childId);
        }
    }
    return dagVotes;
}

async function loadSaveChildren(id: string){
    // we set this false, as this is used on the client's side

    var childCount  = await AnthillContract.methods.readRecTreeVoteCount(id).call();
    for (var i = 0; i < childCount; i++) {
        var childId = await AnthillContract.methods.readRecTreeVote(id, i).call();
        var childName = childId.slice(-4)

        var dagVotes: string[]= await loadDagVotes(childId);

        var childNode = {"id": childId, "name":childName, "parentIds": dagVotes, "treeParentId": id, "childIds": []} as NodeData;
        anthillGraph[id].childIds.push(childId);
        anthillGraph[childId] = childNode;
        loadSaveChildren(childId);
    }
    
}

async function crawlEthereum() {
    // what we want to do here is call the root method in the smart contract, this should return an address
    // with this address we can start crawling the tree
    // for each node we visit, we want to add it to the AnthillGraph

    //call root, we fixed it as 2:
    var rootId : string= anthillRootId();
    var rootName : string= rootId.slice(-4);

    var node = {"id": rootId, "name": rootName, "parentIds": [], "treeParentId": "" ,  "childIds": []} as NodeData;
    anthillGraph[rootId] = node;

    loadSaveChildren(rootId);
}

import express from "express";
// import Quote from 'inspirational-quotes';


const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use((err:any, req:any, res:any, next:any) => {
    res.locals.error = err.response.data;
    const status = err.status || 500;
    res.status(status);
    res.render('error');
});

app.get("/root", function(req, res) {
    console.log("getting root")
    res.send({"anthillGraphNum": anthillGraphNum, "nodeData":anthillGraph[anthillRootId()]});
});    

app.get("/anthillGraphNum", function(req, res) {
    console.log("getting anthillGraphNum")
    res.send({"anthillGraphNum": anthillGraphNum});
    console.log("sent anthillGraphNum")

});    


app.get("/maxRelRootDepth", function(req, res) {
    console.log("getting max rel root");
    res.send({"maxRelRootDepth": maxRelRootDepth});
    
});

app.get("/id/:id", function(req, res) {
    console.log("getting id: ", req.params.id)

    res.send({"anthillGraphNum": anthillGraphNum, "nodeData":anthillGraph[req.params.id]});
});

app.get("/getRelRoot/:id", function(req, res) {
    console.log("getting rel root: ", req.params.id)
    
    var [nodeData, depthDiff] = getRelRoot(req.params.id);
    res.send({"anthillGraphNum": anthillGraphNum, "nodeData":nodeData, "depthDiff": depthDiff});
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

    getAnthillMaxRelRootDepth();
});


//////////////////////

// web3
var Web3 = require('web3');
const anvilUrl = "ws://localhost:8545";
var web3 = new Web3(anvilUrl);

// contract
const anthillContractAddress = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
var fs = require('fs');
var jsonFile = "../anthill/out/Anthill.sol/Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));
var AnthillContract = new web3.eth.Contract(contract.abi, anthillContractAddress);


// types
type GraphData= {[id: string]: NodeData;}
type NodeData = {"id":string, "name":string, "parentIds":string[], "treeParentId": string, "childIds":string[], }

var anthillGraph = {} as GraphData;
var anthillGraphNum =0;
var maxRelRootDepth = 6;


function anthillRootId() {
    // we will need to add a method in the smart contract to get the root id
    return "0x0000000000000000000000000000000000000002";
}


async function getAnthillMaxRelRootDepth() {
    const res = await AnthillContract.methods.readMaxRelRootDepth().call();
    maxRelRootDepth = res;
    
}

function getRelRoot(id: string): [NodeData, number] {
    var node = anthillGraph[id];
    var relRoot = node;
    var depthDiff = 0;

    while (relRoot.treeParentId != ""){
        depthDiff +=1;
        relRoot = anthillGraph[relRoot.treeParentId];
    }
    return [relRoot, depthDiff];
}

async function loadDagVotes(id : string) : Promise<string[]>{
    var dagVotes= [];
    
    var sentDagVoteDiffString = await AnthillContract.methods.readSentDagVoteDiff(id).call();
    var sentDagVoteDiff = parseInt(sentDagVoteDiffString);
    var sentDagVoteCountString="" ;


    for (var i = 0; i < maxRelRootDepth; i++) {
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

    loadAnthillGraph();
   
    // start subscription
    var subscription = web3.eth.subscribe('logs', {"address": anthillContractAddress},
         function(error:any, result:any){ 
            if (!error){
                loadAnthillGraph();
            } else {console.log("we had some error in the eth subscription!", error)}
        }
    )
    // we could call this in the future for more complicated things, see web3.eth docs.
    // .on('data', function( result:any){ 
    //     if (result){
    //         console.log("some data logged!")
    //         console.log(result)
    //         loadAnthillGraph();
    //     } else {console.log("we had some in data, response was none")}; 
    // })
    
}

function loadAnthillGraph() {
    anthillGraph = {} as GraphData;
    anthillGraphNum +=1;

    var rootId : string= anthillRootId();
    var rootName : string= rootId.slice(-4);

    var node = {"id": rootId, "name": rootName, "parentIds": [], "treeParentId": "" ,  "childIds": []} as NodeData;
    anthillGraph[rootId] = node;

    loadSaveChildren(rootId);
    
}

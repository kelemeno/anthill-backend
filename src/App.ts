import express from "express";
// import Quote from 'inspirational-quotes';


const app = express();

app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});


app.get("/root", function(req, res) {
   
    res.send(getNeighbourhood(anthillRootId()));
});    

app.get("/:id", function(req, res) {
 
    res.send(getNeighbourhood(req.params.id));

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

    readRelRootDepth();

});



var Web3 = require('web3');

const antHillContractAddress = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const anvilUrl = "http://localhost:8545";
var web3 = new Web3(anvilUrl);



type GraphData= {[id: string]: NodeData;}
type NodeData = {"id":string, "parentIds":string[], childIds:string[], loaded: boolean}

var anthillGraph = {} as GraphData;
var relRootDepth = 6;

var fs = require('fs');
var jsonFile = "../anthill/out/Anthill.sol/Anthill.json"
var contract= JSON.parse(fs.readFileSync(jsonFile));

var AnthillContract = new web3.eth.Contract(contract.abi, antHillContractAddress);

function anthillRootId() {
    return "0x0000000000000000000000000000000000000002";
}

async function crawlEthereum() {
    // what we want to do here is call the root method in the smart contract, this should return an address
    // with this address we can start crawling the tree
    // for each node we visit, we want to add it to the AnthillGraph

    //call root, we fixed it as 2:
    var rootId : string= anthillRootId();
    var node = {"id": rootId, "parentIds": [], "childIds": [], "loaded": false} as NodeData;
    anthillGraph[rootId] = node;

    loadSaveChildren(rootId);
}

async function readRelRootDepth() {
    // what we want to do here is call the root method in the smart contract, this should return an address
    // with this address we can start crawling the tree
    // for each node we visit, we want to add it to the AnthillGraph

    //call root, we fixed it as 2:
    const res = await AnthillContract.methods.readRelRootDepth().call();
    relRootDepth = res;
}

async function loadSaveChildren(id: string){
    anthillGraph[id].loaded = true;

    var childCount  = await AnthillContract.methods.readRecTreeVoteCount(id).call();
    for (var i = 0; i < childCount; i++) {
        var childId = await AnthillContract.methods.readRecTreeVote(id, i).call();
        var childNode = {"id": childId, "parentIds": [id], "childIds": [], "loaded": false} as NodeData;
        anthillGraph[childId] = childNode;
        anthillGraph[id].childIds.push(childId);
        loadSaveChildren(childId);
    }
}


function getNeighbourhood(id : string) : GraphData{
    var neighbourhood = {} as GraphData;
    var node = anthillGraph[id];
    neighbourhood[id] = node;
    var parent = node;

    for (var i = 0; i < relRootDepth; i++) {
        var parentId = parent.parentIds[i];
        neighbourhood[parentId] = anthillGraph[parentId];
    }
    
    for (var i = 0; i < node.childIds.length; i++) {
        var childId = node.childIds[i];
        neighbourhood[childId] = anthillGraph[childId];
    }
    return neighbourhood;
}


// const OrgChart={
//   "Root": {
//     "id": "Root",
//     "parentIds" : [],
//     "childIds": ["Cain", "Seth", "Abel", "Awan", "Enoch", "Azura"]
//     , "loaded": true, 

//   },
//   "Cain":{
//     "id": "Cain",
//     "parentIds": ["Root"],
//     "childIds": []
//     , "loaded": true, 

//   },
//   "Seth":{
//     "id": "Seth",
//     "parentIds": ["Root"],
//     "childIds": ["Enos", "Noam"]
//     , "loaded": true, 

//   },
//   "Enos":{
//     "id": "Enos",
//     "parentIds": ["Seth"],
//     "childIds": ["C6"]
//     , "loaded": true, 

//   },
//   "Noam":{
//     "id": "Noam",
//     "parentIds": ["Seth"],
//     "childIds": ["C3", "C4"]
//     , "loaded": true, 

//   },
//   "Abel":{
//     "id": "Abel",
//     "parentIds": ["Root"],
//     "childIds": ["C3", "C2", "C1"]
//     , "loaded": true, 

//   },
//   "Awan":{
//     "id": "Awan",
//     "parentIds": ["Root", "Abel"],
//     "childIds": ["C5", "C7", "C8", "C9", ]
//     , "loaded": true, 

//   },
//   "Enoch":{
//     "id": "Enoch",
//     "parentIds": ["Root"],
//     "childIds": []
//     , "loaded": true, 

//   },
//   "Azura":{
//     "id": "Azura",
//     "parentIds": ["Root"],
//     "childIds": []
//     , "loaded": true, 

//   },
//   "C1":{
//     "id": "C1",
//     "parentIds": ["Abel"],
//     "childIds": ["C5"]
//     , "loaded": true, 

//   },
//   "C2":{
//     "id": "C2",
//     "parentIds": ["Abel"],
//     "childIds": ["C4", "C5"]
//     , "loaded": true, 

//   },
//   "C3":{
//     "id": "C3",
//     "parentIds": ["Abel", "Noam"],
//     "childIds": ["C4", "C7"]
//     , "loaded": true, 

//   },
//   "C4":{
//     "id": "C4",
//     "parentIds": ["Noam", "C3", "C2"],
//     "childIds": ["C8", "C9"]
//     , "loaded": true, 


//   },
//   "C5":{
//     "id": "C5",
//     "parentIds": ["Awan", "C2", "C1"],
//     "childIds": ["C8", "C9", "C10"]
//     , "loaded": true, 

//   },
//   "C6":{
//     "id": "C6",
//     "parentIds": ["Enos", "Seth"],
//     "childIds": ["C7"]
//     , "loaded": true, 

//   },
//   "C7":{
//     "id": "C7",
//     "parentIds": ["Awan", "C3", "C6"],
//     "childIds": []
//     , "loaded": true, 

//   },
//   "C8":{
//     "id": "C8",
//     "parentIds": ["Awan", "C4", "C5"],
//     "childIds": ["C10"]
//     , "loaded": true, 

//   },
//   "C9":{
//     "id": "C9",
//     "parentIds": ["Awan", "C4", "C5"],
//     "childIds": ["C10"]
//     , "loaded": true, 

//   },
//   "C10":{
//     "id": "C10",
//     "parentIds": ["C8", "C9", "C5"],
//     "childIds": []
//     , "loaded": true, 

//   },
// } as GraphData
// export default OrgChart 
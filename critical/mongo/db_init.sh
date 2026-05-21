db.createCollection("blog");

db.createUser(
  {
    user: "<placeholder>",
    pwd: "<placeholder>",
    roles: [ { role: "userAdminAnyDatabase", db: "admin" } ]
  }
);

db.createCollection("counters");
db.counters.insertOne({
  _id: "blogPostID",
  index: 1
});